import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  type CodexAdapter,
  type CodexErrorObservation,
  type CodexThreadObservation,
  type IsoTime,
  normalizeText,
  type OnHint,
  type ProviderSessionId,
  type RateLimitObservation,
  type WorktreePath,
} from "@loom/core";
import { z } from "zod";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadUnsubscribeParams } from "./generated/v2/ThreadUnsubscribeParams.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js";
import { type Incoming, RpcConnection, RpcError, redact } from "./protocol.js";
import { PendingRequests } from "./requests.js";
import * as schemas from "./schemas.js";
import { CODEX_VERSION, TaskServer } from "./server.js";

export { CODEX_VERSION, RpcError };
export interface CodexAdapterOptions {
  /** Dedicated per-task state directory. Keep it short enough for a Unix socket. */
  taskDirectory: string;
  executable?: string;
  timeoutMs?: number;
  /** Persist the last allocated generation and seed it after a coordinator restart. */
  initialGeneration?: number;
}
const textInput = (text: string) => [
  { type: "text" as const, text: normalizeText(text), text_elements: [] },
];
const iso = (seconds: number): IsoTime =>
  new Date(seconds * 1000).toISOString() as IsoTime;
const hash = (text: string) =>
  createHash("sha256").update(normalizeText(text)).digest("hex");
function errorObservation(
  error: schemas.ProviderError,
  willRetry: boolean,
): CodexErrorObservation {
  const kind = error.codexErrorInfo;
  return {
    message: redact(error.message),
    willRetry,
    kind:
      kind === "rateLimitExceeded" ||
      kind === "usageLimitExceeded" ||
      kind === "serverOverloaded"
        ? kind
        : "other",
  };
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  return new AppServerAdapter(options);
}

class AppServerAdapter implements CodexAdapter {
  private readonly server: TaskServer;
  private readonly timeoutMs: number;
  private counter: number;
  private currentGeneration: number | null = null;
  private connection: RpcConnection | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<OnHint>();
  private readonly pending = new PendingRequests();
  private readonly paths = new Map<string, WorktreePath>();
  private readonly subscribed = new Set<string>();
  private readonly activity = new Map<string, IsoTime>();
  private readonly errors = new Map<
    string,
    { turnId: string; error: CodexErrorObservation }
  >();
  constructor(options: CodexAdapterOptions) {
    this.server = new TaskServer(
      options.taskDirectory,
      options.executable ?? "codex",
    );
    this.timeoutMs = z
      .number()
      .int()
      .positive()
      .parse(options.timeoutMs ?? 10_000);
    this.counter = z
      .number()
      .int()
      .nonnegative()
      .parse(options.initialGeneration ?? 0);
  }
  generation() {
    return this.currentGeneration;
  }
  activityAt(threadId: ProviderSessionId) {
    return this.activity.get(threadId) ?? null;
  }
  subscribe(onHint: OnHint) {
    this.listeners.add(onHint);
    return () => {
      this.listeners.delete(onHint);
    };
  }
  private hint(threadId: string | null) {
    for (const listener of this.listeners)
      listener({
        source: "codex",
        sessionId: threadId as ProviderSessionId | null,
        worktreePath:
          threadId === null ? null : (this.paths.get(threadId) ?? null),
      });
  }
  private markActivity(threadId: string, at: IsoTime) {
    const previous = this.activity.get(threadId);
    if (!previous || at > previous) this.activity.set(threadId, at);
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(action);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }
  startServer(): Promise<void> {
    return this.exclusive(async () => {
      if (this.server.running && this.connection?.connected) return;
      await this.server.start();
      const deadline = Date.now() + this.timeoutMs;
      try {
        while (true) {
          try {
            await this.connect();
            return;
          } catch (error) {
            if (
              !this.server.running ||
              Date.now() >= deadline ||
              !(error instanceof Error) ||
              error.message !== "Codex connection unavailable"
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      } catch (error) {
        await this.server.stop();
        throw error;
      }
    });
  }
  stopServer(): Promise<void> {
    return this.exclusive(async () => {
      this.connection?.close();
      this.connection = null;
      await this.server.stop();
    });
  }
  reconnect(): Promise<void> {
    return this.exclusive(() => this.connect());
  }
  private async connect() {
    this.connection?.close();
    this.connection = null;
    this.currentGeneration = null;
    this.pending.clear();
    this.subscribed.clear();
    this.errors.clear();
    const generation = ++this.counter;
    const connected = await RpcConnection.connect({
      socketPath: this.server.socket,
      timeoutMs: this.timeoutMs,
      onMessage: (message) => {
        if (generation === this.counter) this.receive(message);
      },
      onDisconnect: () => {
        if (generation !== this.counter) return;
        this.currentGeneration = null;
        this.pending.clear();
        this.subscribed.clear();
        this.hint(null);
      },
    });
    try {
      if (
        (await realpath(connected.codexHome)) !==
        (await realpath(this.server.home))
      )
        throw new Error("Refusing an app-server with a different CODEX_HOME");
      if (!connected.connection.connected)
        throw new Error("Codex disconnected during initialize");
      this.connection = connected.connection;
      this.currentGeneration = generation;
    } catch (error) {
      connected.connection.close();
      throw error;
    }
  }
  private rpc() {
    if (!this.connection?.connected || this.currentGeneration === null)
      throw new Error(
        "Codex disconnected; reconnect and resume the recorded thread",
      );
    return this.connection;
  }
  private receive(message: Incoming) {
    const request = this.pending.receive(message);
    if (request) {
      if (request.activityAt)
        this.markActivity(request.threadId, request.activityAt);
      this.hint(request.threadId);
      return;
    }
    const params = z
      .object({ threadId: schemas.identifier.optional() })
      .parse(message.params ?? {});
    const threadId = params.threadId ?? null;
    if (message.method === "error") {
      const error = z
        .object({
          threadId: schemas.identifier,
          turnId: schemas.identifier,
          error: schemas.providerError,
          willRetry: z.boolean(),
        })
        .parse(message.params);
      this.errors.set(error.threadId, {
        turnId: error.turnId,
        error: errorObservation(error.error, error.willRetry),
      });
    }
    if (threadId && /^(item\/|turn\/|error$)/.test(message.method))
      this.markActivity(
        threadId,
        message.emittedAtMs === undefined
          ? (new Date().toISOString() as IsoTime)
          : iso(message.emittedAtMs / 1000),
      );
    // Notification bodies are not copied into snapshots. Even quota updates only ask for a new read.
    this.hint(threadId);
  }
  async startThread(req: Parameters<CodexAdapter["startThread"]>[0]) {
    const connection = this.rpc();
    const generation = this.currentGeneration;
    const params: ThreadStartParams = {
      ...req,
      config: z.record(z.string(), z.json()).parse(req.config),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      ephemeral: false,
      historyMode: "legacy",
      allowProviderModelFallback: false,
    };
    const { thread } = await connection.rpc(
      "thread/start",
      params,
      schemas.metadataResult,
    );
    this.assertCurrent(connection);
    this.paths.set(thread.id, (await realpath(thread.cwd)) as WorktreePath);
    this.assertCurrent(connection);
    this.markActivity(thread.id, iso(thread.updatedAt));
    this.subscribed.add(thread.id);
    return {
      threadId: thread.id as ProviderSessionId,
      generation: generation as number,
    };
  }
  async startTurn(req: Parameters<CodexAdapter["startTurn"]>[0]) {
    const params: TurnStartParams = {
      threadId: req.threadId,
      input: textInput(req.text),
    };
    const result = await this.rpc().rpc(
      "turn/start",
      params,
      schemas.turnResult,
    );
    return { turnId: result.turn.id };
  }
  async steerTurn(req: Parameters<CodexAdapter["steerTurn"]>[0]) {
    const params: TurnSteerParams = {
      threadId: req.threadId,
      expectedTurnId: req.expectedTurnId,
      input: textInput(req.text),
    };
    const result = await this.rpc().rpc(
      "turn/steer",
      params,
      z.object({ turnId: schemas.identifier }),
    );
    if (result.turnId !== req.expectedTurnId)
      throw new Error(
        "Codex steer returned a different turn ID; delivery is unknown",
      );
    return result;
  }
  async interruptTurn(req: Parameters<CodexAdapter["interruptTurn"]>[0]) {
    const params: TurnInterruptParams = req;
    await this.rpc().rpc("turn/interrupt", params, z.object({}).strict());
  }
  private assertCurrent(connection: RpcConnection) {
    if (connection !== this.connection || !connection.connected)
      throw new Error("Codex connection changed during read");
  }
  async resumeThread(
    threadId: ProviderSessionId,
  ): Promise<CodexThreadObservation> {
    const connection = this.rpc();
    const params: ThreadResumeParams = { threadId, excludeTurns: false };
    const { thread } = await connection.rpc(
      "thread/resume",
      params,
      schemas.threadResult,
    );
    this.assertCurrent(connection);
    const observation = await this.observe(connection, threadId, thread);
    this.assertCurrent(connection);
    this.subscribed.add(threadId);
    return observation;
  }
  async readThread(
    threadId: ProviderSessionId,
  ): Promise<CodexThreadObservation> {
    const connection = this.rpc();
    if (!this.subscribed.has(threadId))
      throw new Error(
        "Resume thread before reading so pending requests are hydrated",
      );
    const params: ThreadReadParams = { threadId, includeTurns: true };
    let thread: schemas.Thread;
    try {
      ({ thread } = await connection.rpc(
        "thread/read",
        params,
        schemas.threadResult,
      ));
    } catch (error) {
      // A thread that `thread/start` created but that has had no turn is loaded yet not
      // materialized, and Codex 0.154 refuses to read it: "thread <id> is not materialized yet;
      // includeTurns is unavailable before first user message". It is idle with no turns. Reading
      // it as anything else deadlocks a run: core maps an unreadable thread to `unknown`, and the
      // send gate never sends the first turn into `unknown`. Found by the first real reviewer run.
      if (isNotMaterialized(error)) {
        this.assertCurrent(connection);
        return {
          provider: "codex",
          threadId,
          generation: this.currentGeneration as number,
          status: "idle",
          activeFlags: [],
          turns: [],
          lastError: null,
          pendingRequests: [],
          rateLimits: null,
        };
      }
      throw error;
    }
    return this.observe(connection, threadId, thread);
  }
  private async observe(
    connection: RpcConnection,
    threadId: ProviderSessionId,
    thread: schemas.Thread,
  ): Promise<CodexThreadObservation> {
    if (thread.id !== threadId)
      throw new Error("Codex returned a different thread");
    const cwd = (await realpath(thread.cwd)) as WorktreePath;
    this.assertCurrent(connection);
    this.paths.set(threadId, cwd);
    this.markActivity(threadId, iso(thread.updatedAt));
    const turns = thread.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      error: turn.error ? errorObservation(turn.error, false) : null,
      userMessageHashes: turn.items.flatMap((item) =>
        "content" in item
          ? [
              hash(
                item.content
                  .flatMap((part) => ("text" in part ? [part.text] : []))
                  .join("\n"),
              ),
            ]
          : [],
      ),
    }));
    const last = turns.at(-1);
    const transient = this.errors.get(threadId);
    return {
      provider: "codex",
      threadId,
      generation: this.currentGeneration as number,
      status: thread.status.type,
      activeFlags:
        thread.status.type === "active" ? [...thread.status.activeFlags] : [],
      turns,
      lastError:
        last?.error ??
        (last?.status === "inProgress" && transient?.turnId === last.id
          ? transient.error
          : null),
      pendingRequests: this.pending.observe(threadId),
      // Separate authoritative read. A previous quota read or sparse update may be stale.
      rateLimits: null,
    };
  }
  async unsubscribe(threadId: ProviderSessionId) {
    const params: ThreadUnsubscribeParams = { threadId };
    const connection = this.rpc();
    await connection.rpc(
      "thread/unsubscribe",
      params,
      z.object({
        status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"]),
      }),
    );
    this.assertCurrent(connection);
    this.subscribed.delete(threadId);
    this.pending.forget(threadId);
  }
  async answerRequest(req: Parameters<CodexAdapter["answerRequest"]>[0]) {
    const connection = this.rpc();
    if (req.generation !== this.currentGeneration)
      throw new Error("Stale Codex request generation");
    this.pending.answer(req, connection);
  }
  async readRateLimits(): Promise<RateLimitObservation> {
    const limits = await this.rpc().rpc(
      "account/rateLimits/read",
      {},
      schemas.rateLimitsResult,
    );
    if (limits.ordinaryUsageAllowed === null)
      throw new Error("Codex usage allowance unavailable");
    const buckets = [
      limits.rateLimits,
      ...Object.values(limits.rateLimitsByLimitId ?? {}),
    ];
    const resets = buckets
      .flatMap((bucket) => [bucket.primary, bucket.secondary])
      .flatMap((window) =>
        window && window.usedPercent >= 100 && window.resetsAt !== null
          ? [window.resetsAt]
          : [],
      );
    return {
      usageAllowed: limits.ordinaryUsageAllowed,
      resetsAt: resets.length ? iso(Math.max(...resets)) : null,
    };
  }
  async checkResumable(threadId: ProviderSessionId): Promise<boolean | null> {
    let probe: RpcConnection | undefined;
    try {
      const connected = await RpcConnection.connect({
        socketPath: this.server.socket,
        timeoutMs: this.timeoutMs,
        onMessage: () => {},
        onDisconnect: () => {},
      });
      probe = connected.connection;
      if (
        (await realpath(connected.codexHome)) !==
        (await realpath(this.server.home))
      )
        return null;
      const params: ThreadReadParams = { threadId, includeTurns: false };
      try {
        const { thread } = await probe.rpc(
          "thread/read",
          params,
          schemas.metadataResult,
        );
        return thread.id === threadId ? true : null;
      } catch (error) {
        if (
          !(error instanceof RpcError) ||
          error.code !== -32600 ||
          error.message !== `thread not loaded: ${threadId}`
        )
          throw error;
        // Only caller-recorded Loom threads may be checked: this fallback loads an unloaded thread.
        const resume: ThreadResumeParams = { threadId, excludeTurns: true };
        const { thread } = await probe.rpc(
          "thread/resume",
          resume,
          schemas.metadataResult,
        );
        return thread.id === threadId ? true : null;
      }
    } catch (error) {
      // Exact 0.154.0 missing-history error. Other errors, including socket loss, are unknown.
      return error instanceof RpcError &&
        error.code === -32600 &&
        error.message === `no rollout found for thread id ${threadId}`
        ? false
        : null;
    } finally {
      probe?.close();
    }
  }
  attachArgs(threadId: ProviderSessionId) {
    return [
      this.server.executable,
      "resume",
      threadId,
      "--remote",
      `unix://${this.server.socket}`,
    ];
  }
}

/** Codex's refusal to read a loaded thread that has not had its first user message yet. */
export const isNotMaterialized = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof (error as { message: unknown }).message === "string" &&
  /is not materialized yet/.test((error as { message: string }).message);
