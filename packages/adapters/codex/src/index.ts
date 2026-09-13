import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  type CodexAdapter,
  type CodexErrorObservation,
  type CodexThreadObservation,
  type IsoTime,
  type McpServerEntry,
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
import { PendingRequests, StaleCodexRequestError } from "./requests.js";
import * as schemas from "./schemas.js";
import { CODEX_VERSION, TaskServer } from "./server.js";

export { CODEX_VERSION, RpcError, StaleCodexRequestError };
export interface CodexAdapterOptions {
  onDiagnostic?: (event: import("@loom/core").AdapterDiagnostic) => void;
  /** Dedicated per-task state directory. Keep it short enough for a Unix socket. */
  taskDirectory: string;
  executable?: string;
  timeoutMs?: number;
  /** Persist the last allocated generation and seed it after a coordinator restart. */
  initialGeneration?: number;
  /** Store-backed session owners checked immediately before recovery signals a task server. */
  liveSessionOwners?: () => Promise<readonly ProviderSessionId[]>;
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
      undefined,
      options.onDiagnostic,
      options.liveSessionOwners,
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
      // A successful start/adoption followed by an observer failure is not permission to kill
      // the task server: it may still own a live turn. Leave it for guarded recovery or an
      // explicit stop.
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
      await this.hydrateSubscriptions(connected.connection);
    } catch (error) {
      connected.connection.close();
      throw error;
    }
  }
  /** Rebuild connection-scoped server subscriptions from durable adapter intent. */
  private async hydrateSubscriptions(connection: RpcConnection): Promise<void> {
    for (const threadId of this.subscribed) {
      const params: ThreadResumeParams = { threadId, excludeTurns: false };
      const { thread } = await connection.rpc(
        "thread/resume",
        params,
        schemas.threadResult,
      );
      this.assertCurrent(connection);
      await this.observe(connection, threadId as ProviderSessionId, thread);
      this.assertCurrent(connection);
    }
  }
  private rpc() {
    if (!this.connection?.connected || this.currentGeneration === null)
      throw new Error(
        "Codex disconnected; reconnect and resume the recorded thread",
      );
    return this.connection;
  }
  private async reconnectAfterDisconnection(): Promise<void> {
    // A dropped observer does not imply a dead owner. Reconnect to the same socket first; only a
    // genuinely unavailable socket permits TaskServer to consider adoption or replacement.
    try {
      await this.connect();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Codex connection unavailable"
      )
        throw error;
      await this.server.start();
      await this.connect();
    }
  }
  /** Wraps an RPC action to automatically reconnect if the connection is lost. */
  private async rpcWithReconnect<T>(action: () => Promise<T>): Promise<T> {
    let originalError: Error | null = null;
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const message = error.message;
      // Detect disconnection: either pre-flight check or mid-flight socket termination
      const isDisconnected =
        message ===
          "Codex disconnected; reconnect and resume the recorded thread" ||
        message === "Codex connection closed" ||
        message === "Codex connection unavailable";
      if (!isDisconnected) {
        // Not a disconnection error; re-throw as-is
        throw error;
      }
      // Connection lost; attempt reconnection once
      originalError = error;
      try {
        await this.reconnectAfterDisconnection();
        // Reconnection successful; retry the action once
        return await action();
      } catch (reconnectError) {
        // Reconnection failed; prefer to throw the original error if it's more informative
        const reconnectMessage =
          reconnectError instanceof Error
            ? reconnectError.message
            : String(reconnectError);
        // If the reconnection error is about process verification, throw the original error
        if (
          reconnectMessage.includes("Cannot verify") ||
          reconnectMessage.includes("Multiple")
        ) {
          throw originalError;
        }
        // Otherwise throw the reconnection error
        throw reconnectError;
      }
    }
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
    return this.rpcWithReconnect(async () => {
      const connection = this.rpc();
      const generation = this.currentGeneration;
      const params: ThreadStartParams = {
        ...req,
        config: z.record(z.string(), z.json()).parse(req.config),
        // Never prompt (user decision, 2026-09-12): a command the sandbox forbids fails visibly
        // in the transcript instead of parking the run on a request nobody is watching.
        approvalPolicy: "never",
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
    });
  }
  async startTurn(req: Parameters<CodexAdapter["startTurn"]>[0]) {
    return this.rpcWithReconnect(async () => {
      const params: TurnStartParams = {
        threadId: req.threadId,
        input: textInput(req.text),
        ...(req.model ? { model: req.model } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
      };
      const result = await this.rpc().rpc(
        "turn/start",
        params,
        schemas.turnResult,
      );
      return { turnId: result.turn.id };
    });
  }
  async steerTurn(req: Parameters<CodexAdapter["steerTurn"]>[0]) {
    return this.rpcWithReconnect(async () => {
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
    });
  }
  async interruptTurn(req: Parameters<CodexAdapter["interruptTurn"]>[0]) {
    return this.rpcWithReconnect(async () => {
      const params: TurnInterruptParams = req;
      await this.rpc().rpc("turn/interrupt", params, z.object({}).strict());
    });
  }
  private assertCurrent(connection: RpcConnection) {
    if (connection !== this.connection || !connection.connected)
      throw new Error("Codex connection changed during read");
  }
  async resumeThread(
    threadId: ProviderSessionId,
  ): Promise<CodexThreadObservation> {
    return this.rpcWithReconnect(async () => {
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
    });
  }
  async readThread(
    threadId: ProviderSessionId,
  ): Promise<CodexThreadObservation> {
    return this.rpcWithReconnect(async () => {
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
    });
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
    return this.rpcWithReconnect(async () => {
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
    });
  }
  async answerRequest(req: Parameters<CodexAdapter["answerRequest"]>[0]) {
    return this.rpcWithReconnect(async () => {
      const connection = this.rpc();
      if (req.generation !== this.currentGeneration)
        throw new StaleCodexRequestError("Stale Codex request generation");
      this.pending.answer(req, connection);
    });
  }
  async readRateLimits(): Promise<RateLimitObservation> {
    return this.rpcWithReconnect(async () => {
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
    });
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
      let loaded: boolean;
      try {
        const { thread } = await probe.rpc(
          "thread/read",
          params,
          schemas.metadataResult,
        );
        if (thread.id !== threadId) return null;
        loaded = thread.status.type !== "notLoaded";
      } catch (error) {
        if (
          !(error instanceof RpcError) ||
          error.code !== -32600 ||
          error.message !== `thread not loaded: ${threadId}`
        )
          throw error;
        loaded = false;
      }
      if (loaded) return true;
      // A thread Codex knows but has not loaded is answered from its state database, which
      // outlives the rollout file; only `thread/resume` proves the history is still there. Only
      // caller-recorded Loom threads may be checked: this loads the thread.
      const resume: ThreadResumeParams = { threadId, excludeTurns: true };
      const { thread } = await probe.rpc(
        "thread/resume",
        resume,
        schemas.metadataResult,
      );
      return thread.id === threadId ? true : null;
    } catch (error) {
      // The two 0.154.0 missing-history errors: the thread is not in Codex's state at all, or
      // it is but its rollout file is gone (the path carries the thread ID). Other errors,
      // including socket loss, are unknown.
      return error instanceof RpcError &&
        error.code === -32600 &&
        (error.message === `no rollout found for thread id ${threadId}` ||
          (error.message.startsWith("failed to resolve rollout path") &&
            error.message.includes(threadId)))
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
/**
 * Loom's MCP registration in Codex's `mcp_servers.<name>` vocabulary. Codex 0.154 reads HTTP
 * headers from `http_headers`, not Claude's `headers`: passed through unchanged, the reviewer
 * connected without its bearer token and every tool call answered `unknown_run`.
 */
export function codexMcpServer(entry: McpServerEntry): Record<string, unknown> {
  if ("command" in entry)
    return {
      command: entry.command,
      args: entry.args,
      ...(entry.env ? { env: entry.env } : {}),
    };
  return {
    url: entry.url,
    ...(entry.headers ? { http_headers: entry.headers } : {}),
  };
}

export const isNotMaterialized = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof (error as { message: unknown }).message === "string" &&
  /is not materialized yet/.test((error as { message: string }).message);
