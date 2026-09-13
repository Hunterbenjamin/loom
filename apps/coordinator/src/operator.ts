// One instance identity; SQLite owns its queue, receipts, decisions and filing quota.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  InputId,
  IsoTime,
  McpServerEntry,
  Observations,
  PaneRef,
  ProviderSessionId,
  RunId,
  TaskId,
  TaskState,
  WorktreePath,
} from "@loom/core";
import { normalizeText } from "@loom/core";
import { paneIdentity } from "@loom/protocol";
import type { OperatorEvent, Store, TaskNote } from "@loom/store";
import { z } from "zod";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import { newToken, sha256 } from "./derive.js";
import { inspectTask } from "./inspect.js";
import {
  eventKey,
  normalizeFailure,
  sanitizeEvidence,
} from "./operator-evidence.js";
import { attentionOccurrence, operatorPolicy } from "./operator-policy.js";
import { operatorBrief } from "./prompts.js";
import { runEnvironment } from "./recipes.js";

const recipeSchema = z.strictObject({
  sessionId: z.string().uuid(),
  token: z.string().min(16),
  stopped: z.boolean(),
  launched: z.boolean(),
  mcpPort: z.number().int(),
  cwd: z.string(),
  model: z.string().optional(),
  pane: paneIdentity.nullable().optional(),
  delivery: z
    .object({
      hash: z.string(),
      at: z.string(),
      promptId: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
const receiptSchema = z.object({ inputId: z.string(), command: z.string() });
export const filingInput = z.strictObject({
  eventId: z.string(),
  title: z.string().min(1).max(200),
  summary: z
    .string()
    .min(1)
    .max(140)
    .regex(/^[^\r\n]*$/, "Summary must be one line"),
  description: z.string().min(1).max(6000),
  acceptanceTest: z.string().min(10).max(3000),
});
interface Deps {
  store: Store;
  adapters: Pick<Adapters, "claude" | "paneHost">;
  config: CoordinatorConfig;
  mcpEntry(token: string): McpServerEntry;
  now(): IsoTime;
  observe(state: TaskState): Promise<Observations>;
  workflow(state: TaskState): Promise<Record<string, string>>;
  reconcile(taskId: TaskId): Promise<unknown>;
  enqueue(taskId: TaskId): void;
  changed(taskId: TaskId | null): Promise<void>;
  createBug(
    title: string,
    summary: string,
    description: string,
    signature: string,
  ): TaskState;
}
export class OperatorSession {
  private recipe: z.output<typeof recipeSchema> | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private calls: Promise<unknown> = Promise.resolve();
  private active = false;
  private nativeStatus: "idle" | "working" | "waiting" | "unknown" = "unknown";
  private delivered = new Set<string>();
  private error: string | null = null;
  private ready = false;
  constructor(private readonly deps: Deps) {}
  get sessionId() {
    return this.recipe?.sessionId ?? null;
  }
  get mcpPort() {
    return this.recipe?.mcpPort ?? 0;
  }
  private get directory() {
    return join(this.deps.store.dataDirectory, "operator");
  }
  resolve(token: string) {
    return token && token === this.recipe?.token
      ? { kind: "operator" as const, active: !this.recipe.stopped }
      : null;
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lifecycle.then(fn);
    this.lifecycle = p.catch(() => {});
    return p;
  }
  async load() {
    this.error = this.deps.store.operator.get(
      "session_error",
      z.string().nullable(),
    );
    try {
      this.recipe = recipeSchema.parse(
        JSON.parse(await readFile(join(this.directory, "recipe.json"), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (this.recipe && this.recipe.cwd !== this.deps.store.dataDirectory)
      throw new Error("Operator recipe belongs to another instance");
  }
  private async save(recipe: z.output<typeof recipeSchema>) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const value = recipeSchema.parse(recipe);
    await writeFile(join(this.directory, "recipe.tmp"), JSON.stringify(value), {
      mode: 0o600,
    });
    await rename(
      join(this.directory, "recipe.tmp"),
      join(this.directory, "recipe.json"),
    );
    this.recipe = value;
  }
  async close() {
    this.ready = false;
    await this.calls.catch(() => {});
    await this.exclusive(async () => {
      // The interactive process belongs to tmux and survives coordinator restarts.
      if (this.recipe)
        await this.deps.adapters.claude.closeHeadless(
          this.recipe.sessionId as ProviderSessionId,
        );
      this.active = false;
    });
  }
  async recover() {
    this.ready = true;
    await this.pump().catch((error) => {
      this.error = sanitizeEvidence(String(error));
      this.deps.store.operator.set("session_error", this.error);
    });
  }
  open() {
    return this.exclusive(async () => {
      if (this.recipe) await this.save({ ...this.recipe, stopped: false });
      this.error = null;
      this.deps.store.operator.set("session_error", null);
      this.ready = true;
      if (!this.recipe) await this.initialize();
      await this.ensureTerminal();
    }).then(() => this.pump());
  }
  stop() {
    return this.exclusive(async () => {
      if (!this.recipe) await this.initialize();
      if (!this.recipe) return;
      await this.save({ ...this.recipe, stopped: true });
      await this.deps.adapters.claude.stopHeadless(
        this.recipe.sessionId as ProviderSessionId,
      );
      if (this.recipe.pane)
        await this.deps.adapters.paneHost.closePane(this.recipe.pane);
      await this.save({ ...this.recipe, delivery: null });
      this.active = false;
      this.delivered.clear();
    });
  }
  get paneRef(): PaneRef | null {
    return this.recipe?.pane ?? null;
  }
  private async ensureTerminal(): Promise<PaneRef> {
    const recipe = this.recipe;
    if (!recipe) throw new Error("Missing Operator identity");
    const { claude, paneHost } = this.deps.adapters;
    if (recipe.pane) {
      const pane = await paneHost.getPane(recipe.pane);
      if (pane && !pane.dead && pane.startCwd === recipe.cwd) return pane.ref;
    }
    // Never share a Claude identity between the old headless process and the TUI.
    const owned = await claude.headlessState(
      recipe.sessionId as ProviderSessionId,
    );
    if (owned && !owned.exited)
      await claude.closeHeadless(recipe.sessionId as ProviderSessionId);
    const sessions = await claude.listSessions();
    if (
      sessions.some(
        (s) => s.sessionId === recipe.sessionId && s.cwd === recipe.cwd,
      )
    )
      throw new Error(
        "Operator session is still live without its recorded terminal; refusing a duplicate launch",
      );
    const settingsPath = join(this.directory, "settings.json");
    await claude.writeSettings(settingsPath, this.deps.mcpEntry(recipe.token));
    const resume =
      recipe.launched &&
      (await claude.resumable(
        recipe.sessionId as ProviderSessionId,
        recipe.cwd as WorktreePath,
      ));
    const args = [
      ...claude.interactiveArgs({
        sessionId: recipe.sessionId as ProviderSessionId,
        resume,
        model:
          recipe.model ??
          this.deps.config.operatorModel ??
          this.deps.config.models.claude,
        settingsPath,
        readOnly: false,
      }),
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--append-system-prompt",
      operatorBrief(),
    ];
    await this.save({ ...recipe, launched: true });
    const { workspaceId } = await paneHost.ensureWorkspace({
      taskId: "operator" as TaskId,
      cwd: recipe.cwd as WorktreePath,
      label: "Operator",
    });
    const pane = await paneHost.ensurePane({
      workspaceId,
      runId: "operator" as RunId,
      cwd: recipe.cwd as WorktreePath,
      executable: this.deps.config.claudeExecutable,
      args,
      env: runEnvironment(process.env, {
        LOOM_INSTANCE: this.deps.config.instance,
        LOOM_MCP_TOKEN: recipe.token,
      }),
    });
    await this.save({
      ...(this.recipe as NonNullable<typeof this.recipe>),
      pane,
    });
    return pane;
  }
  private async initialize() {
    const token = newToken();
    const entry = this.deps.mcpEntry(token);
    if (!("type" in entry) || entry.type !== "http")
      throw new Error("Operator requires HTTP MCP");
    await this.save({
      sessionId: randomUUID(),
      token,
      stopped: false,
      launched: false,
      mcpPort: Number(new URL(entry.url).port),
      cwd: this.deps.store.dataDirectory,
      model: this.deps.config.operatorModel ?? this.deps.config.models.claude,
    });
  }
  state() {
    const notes = this.deps.store.operator.notes();
    return {
      id: "operator" as const,
      sessionId: this.sessionId,
      status: this.recipe?.stopped
        ? ("stopped" as const)
        : this.error
          ? ("error" as const)
          : this.nativeStatus === "waiting"
            ? ("waiting" as const)
            : this.active
              ? ("working" as const)
              : this.nativeStatus,
      queueLength: this.deps.store.operator.queueLength(),
      lastAction: notes[0]?.outcome ?? null,
      lastActionAt: notes[0]?.at ?? null,
      actions: notes,
      filedThisHour: this.deps.store.operator.count(this.deps.now()),
      error: this.error,
      escalation: this.deps.store.operator.get(
        "escalation",
        z.string().nullable(),
      ),
    };
  }
  capture(state: TaskState) {
    const task = state.task;
    if (task.attention.reasons.length) {
      const occurrence = attentionOccurrence(state);
      this.event({
        kind: "attention",
        taskId: task.id,
        runId: null,
        message: task.attention.reasons.join(", "),
        occurrence,
      });
    }
    for (const run of state.runs)
      if (
        run.endedAt &&
        ["vanished", "crashed", "failed"].includes(run.endReason ?? "")
      )
        this.event({
          kind: "run_ended",
          taskId: task.id,
          runId: run.id,
          message: `${run.role} ${run.endReason}`,
          occurrence: `${run.id}:${run.attempts}:${run.endedAt}`,
        });
  }
  event(
    input: Pick<
      OperatorEvent,
      "kind" | "taskId" | "runId" | "message" | "occurrence"
    >,
  ) {
    const message = sanitizeEvidence(input.message),
      occurrence =
        input.kind === "attention"
          ? input.occurrence
          : sanitizeEvidence(input.occurrence);
    this.deps.store.operator.enqueue({
      ...input,
      message,
      occurrence,
      id: eventKey(`${input.kind}:${input.taskId}:${occurrence}`),
      at: this.deps.now(),
      count: 1,
    });
    this.wake();
  }
  failure(
    kind: "pass_failed" | "publish_failed" | "stale_process",
    taskId: string | null,
    message: string,
    runId: string | null = null,
  ) {
    const occurrence = `${eventKey(sanitizeEvidence(message))}:${this.deps.now().slice(0, 13)}`;
    const id = eventKey(`${kind}:${taskId}:${occurrence}`);
    if (this.deps.store.operator.event(id)) {
      this.deps.store.operator.increment(id);
      return;
    }
    this.event({ kind, taskId, runId, message, occurrence });
  }
  private wake() {
    if (this.ready)
      void this.pump().catch((e) => {
        this.error = sanitizeEvidence(String(e));
        this.deps.store.operator.set("session_error", this.error);
      });
  }
  pump(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.ready || this.recipe?.stopped) return;
      const events = this.deps.store.operator.pending();
      if (this.error) return;
      if (!this.recipe && !events.length) return;
      if (!this.recipe) await this.initialize();
      const recipe = this.recipe;
      if (!recipe) return;
      const pane = await this.ensureTerminal();
      const sessionId = recipe.sessionId as ProviderSessionId;
      const [sessions, hooks] = await Promise.all([
        this.deps.adapters.claude.listSessions(),
        this.deps.adapters.claude.hookSummary(sessionId),
      ]);
      const session = sessions.find(
        (s) => s.sessionId === sessionId && s.cwd === recipe.cwd,
      );
      this.nativeStatus =
        hooks.pendingDialog || session?.status === "waiting"
          ? "waiting"
          : session?.status === "busy"
            ? "working"
            : session?.status === "idle"
              ? "idle"
              : "unknown";
      const delivery = recipe.delivery;
      if (delivery) {
        this.active = true;
        if (hooks.stopFailure && hooks.stopFailure.at >= delivery.at) {
          this.error = sanitizeEvidence(
            `Operator turn failed: ${hooks.stopFailure.error}. Open Operator to retry.`,
          );
          this.deps.store.operator.set("session_error", this.error);
          this.active = false;
          await this.save({
            ...(this.recipe as NonNullable<typeof this.recipe>),
            delivery: null,
          });
          return;
        }
        const submitted = hooks.promptSubmits.find(
          (p) => p.textHash === delivery.hash && p.at >= delivery.at,
        );
        const promptId = delivery.promptId ?? submitted?.promptId;
        if (promptId && !delivery.promptId)
          await this.save({
            ...(this.recipe as NonNullable<typeof this.recipe>),
            delivery: { ...delivery, promptId },
          });
        if (!promptId || hooks.lastStop?.promptId !== promptId) {
          if (
            !promptId &&
            Date.parse(this.deps.now()) - Date.parse(delivery.at) > 30000
          ) {
            this.error =
              "Operator input delivery is unconfirmed; inspect its terminal before retrying.";
            this.deps.store.operator.set("session_error", this.error);
          }
          return;
        }
        this.active = false;
        this.delivered.clear();
        await this.save({
          ...(this.recipe as NonNullable<typeof this.recipe>),
          delivery: null,
        });
      }
      // Native provider status is the send gate. Never paste into an approval or busy turn.
      if (!events.length || session?.status !== "idle" || hooks.pendingDialog)
        return;
      const prompt = `${operatorBrief()}\nEvents (coalesced by task):\n${JSON.stringify(
        events.reduce<Record<string, OperatorEvent[]>>((groups, e) => {
          const key = e.taskId ?? "instance";
          groups[key] ??= [];
          groups[key].push(e);
          return groups;
        }, {}),
      )}`;
      for (const event of events)
        this.deps.store.operator.set(`delivery:${event.id}`, {
          sessionId: recipe.sessionId,
          at: this.deps.now(),
          attempted: true,
        });
      this.active = true;
      this.delivered = new Set(events.map((e) => e.id));
      try {
        // Persist before paste. Only UserPromptSubmit confirms delivery; an uncertain paste is not replayed.
        await this.save({
          ...(this.recipe as NonNullable<typeof this.recipe>),
          delivery: {
            hash: sha256(normalizeText(prompt)),
            at: this.deps.now(),
            promptId: null,
          },
        });
        await this.deps.adapters.paneHost.pasteText(pane, prompt);
      } catch (e) {
        this.active = false;
        this.error = sanitizeEvidence(String(e));
        this.deps.store.operator.set("session_error", this.error);
        throw e;
      }
    });
  }
  invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
    const p = this.calls.then(async () => {
      if (this.recipe?.stopped) throw new Error("Operator stopped");
      const result = await this.call(name, input);
      if (input.eventId) {
        const event = this.deps.store.operator.event(String(input.eventId));
        await this.deps.changed((event?.taskId as TaskId) ?? null);
      }
      const events = this.deps.store.operator
        .pending()
        .filter((e) => !this.delivered.has(e.id));
      for (const e of events) this.delivered.add(e.id);
      return { result, events };
    });
    this.calls = p.catch(() => {});
    return p;
  }
  private note(
    event: OperatorEvent,
    row: string,
    outcome: string,
    body: string,
    forHuman: boolean,
    taskId = event.taskId,
  ) {
    const note: TaskNote = {
      id: `${event.id}:${outcome}`,
      taskId,
      author: "operator",
      at: this.deps.now(),
      eventId: event.id,
      row,
      outcome,
      body: sanitizeEvidence(body),
      forHuman,
      occurrence:
        forHuman && taskId
          ? attentionOccurrence(this.deps.store.loadTaskState(taskId as TaskId))
          : event.occurrence,
    };
    this.deps.store.operator.note(note);
    return note;
  }
  private async call(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const { store } = this.deps;
    if (name === "list_tasks") return store.tasks();
    if (name === "list_repos") return store.repos();
    if (name === "inspect_task")
      return inspectTask(store, input.taskId as TaskId);
    if (name === "operator_events") return store.operator.pending();
    const event = store.operator.event(String(input.eventId ?? ""));
    if (!event)
      return { accepted: false, reason: "A persisted eventId is required" };
    if (
      ![
        "file_task",
        "append_note",
        "answer_provider_request",
        "answer_pane_prompt",
        "retry_task",
        "push_branch",
        "open_pr",
      ].includes(name)
    ) {
      this.note(
        event,
        "fallback",
        `refused:${name}`,
        "Policy v1 forbids this command; no action taken.",
        false,
      );
      return { accepted: false, reason: "Policy v1 forbids this command" };
    }
    if (store.operator.isProcessed(event.id))
      return { accepted: true, replayed: true };
    if (name === "file_task") return this.file(event, filingInput.parse(input));
    if (!event.taskId) {
      if (name !== "append_note")
        return {
          accepted: false,
          reason: "Unroutable instance event requires escalation",
        };
      store.operator.atomic(() => {
        this.note(event, "fallback", "escalated", event.message, true);
        store.operator.set("escalation", event.message);
        store.operator.complete(event.id, this.deps.now());
      });
      return { accepted: true };
    }
    const taskId = event.taskId as TaskId;
    // Finish a previously enqueued command before policy is re-evaluated on the changed state.
    const receipt = store.operator.get(
      `action:${event.id}:${name}`,
      receiptSchema,
    );
    if (receipt) return this.finishAction(event, name, receipt.inputId);
    await this.deps.reconcile(taskId);
    const state = store.loadTaskState(taskId);
    if (
      event.kind === "attention" &&
      event.occurrence !== attentionOccurrence(state)
    ) {
      store.operator.atomic(() => {
        this.note(
          event,
          "fallback",
          "stale",
          "Attention occurrence resolved or changed; no action taken.",
          false,
        );
        store.operator.complete(event.id, this.deps.now());
      });
      return { accepted: false, reason: "Stale attention occurrence" };
    }
    if (event.kind === "run_ended" && event.runId) {
      const run = state.runs.find((r) => r.id === event.runId);
      if (
        !run?.endedAt ||
        event.occurrence !== `${run.id}:${run.attempts}:${run.endedAt}`
      ) {
        store.operator.atomic(() => {
          this.note(
            event,
            "fallback",
            "stale",
            "Run failure occurrence has changed; no action taken.",
            false,
          );
          store.operator.complete(event.id, this.deps.now());
        });
        return { accepted: false, reason: "Stale run occurrence" };
      }
    }
    const episode = this.episode(state);
    const decision = operatorPolicy(
      event,
      state,
      await this.deps.observe(state),
      await this.deps.workflow(state),
      store.operator.get(episode, z.boolean()) === true,
    );
    if (name === "append_note" && !decision.command && !decision.file) {
      store.operator.atomic(() => {
        this.note(
          event,
          decision.row,
          decision.wait ? "waiting" : "escalated",
          decision.summary,
          !decision.wait,
        );
        store.operator.complete(event.id, this.deps.now());
      });
      return { accepted: true, decision };
    }
    const type = name === "retry_task" ? "retry" : name;
    if (!decision.command || type !== decision.command.type) {
      this.note(
        event,
        decision.row,
        `refused:${name}`,
        decision.summary,
        false,
      );
      return { accepted: false, decision };
    }
    if (this.recipe?.stopped)
      return { accepted: false, reason: "Operator stopped" };
    const command = decision.command;
    // Arguments cannot override coordinator-selected destinations, epochs, requests or choices.
    const id = `operator:${event.id}:${name}` as InputId;
    store.operator.atomic(() => {
      store.enqueueInput(taskId, {
        id,
        receivedAt: this.deps.now(),
        type: "human",
        command,
      });
      store.operator.set(`action:${event.id}:${name}`, {
        inputId: id,
        command: JSON.stringify(command),
      });
      if (command.type === "retry") store.operator.set(episode, true);
      this.note(event, decision.row, `queued:${name}`, decision.summary, false);
    });
    return this.finishAction(event, name, id);
  }
  private episode(state: TaskState) {
    const run =
      state.runs.find((r) => r.id === state.task.failed?.runId) ??
      state.runs.find(
        (r) => r.mode === "headless" && (r.status === "failed" || r.endedAt),
      );
    return `retry:${state.task.id}:${run?.role}:${run?.round}`;
  }
  private async finishAction(event: OperatorEvent, name: string, id: string) {
    const { store } = this.deps;
    const taskId = event.taskId as TaskId;
    await this.deps.reconcile(taskId);
    const disposition = store.inputDisposition(taskId, id);
    if (!disposition) return { accepted: false, pending: true };
    this.note(
      event,
      "action.result",
      `${disposition.accepted ? "accepted" : "refused"}:${name}`,
      disposition.accepted
        ? "Command accepted by core; no stage change is implied."
        : JSON.stringify(disposition.error),
      !disposition.accepted || name === "open_pr",
    );
    if (name !== "push_branch" || !disposition.accepted)
      store.operator.complete(event.id, this.deps.now());
    this.deps.enqueue(taskId);
    return disposition;
  }
  private file(event: OperatorEvent, input: z.output<typeof filingInput>) {
    const { store, config } = this.deps;
    if (
      !["pass_failed", "publish_failed", "stale_process"].includes(event.kind)
    )
      return {
        accepted: false,
        reason: "Only runtime bug events can be filed",
      };
    return store.operator.atomic(() => {
      const signature = normalizeFailure(event.kind, event.message);
      let taskId = store.operator.match(signature);
      if (
        !taskId &&
        (!config.operator.repoId ||
          !store.repos().some((r) => r.id === config.operator.repoId))
      ) {
        const summary =
          "Runtime bug filing needs operator.repoId naming the registered destination repository.";
        this.note(
          event,
          "bug.file",
          "unroutable",
          `${summary}\n${event.message}`,
          true,
        );
        store.operator.set("escalation", summary);
        return { accepted: false, reason: summary };
      }
      if (
        !taskId &&
        store.operator.count(this.deps.now()) >= config.operator.maxFiledPerHour
      ) {
        const count = (store.operator.get("suppressed", z.number()) ?? 0) + 1;
        store.operator.set("suppressed", count);
        const summary = `Filing paused: ${count} distinct events suppressed by the rolling-hour limit.`;
        store.operator.set("escalation", summary);
        const previous = store.operator.get(
          "quota_note",
          z.string().nullable(),
        );
        const noteId = previous ?? `quota:${event.id}`;
        store.operator.set("quota_note", noteId);
        const prior = store.operator.noteById(noteId);
        store.operator.updateNote({
          id: noteId,
          taskId: null,
          author: "operator",
          at: prior?.at ?? this.deps.now(),
          eventId: prior?.eventId ?? event.id,
          row: "bug.file",
          outcome: "rate_limited",
          body: sanitizeEvidence(
            `${summary}\n${event.message}\n${prior?.body ?? ""}`,
          ),
          forHuman: true,
          occurrence: noteId,
        });
        store.operator.complete(event.id, this.deps.now());
        return { accepted: false, rateLimited: true };
      }
      if (!taskId) {
        if (store.operator.get("quota_note", z.string().nullable())) {
          store.operator.set("quota_note", null);
          store.operator.set("suppressed", 0);
          store.operator.set("escalation", null);
        }
        const evidence = event.taskId
          ? inspectTask(store, event.taskId as TaskId)
          : null;
        const description = `${sanitizeEvidence(input.description).slice(0, 3000)}\n\nSignature: ${signature}\n\nEvidence:\n${sanitizeEvidence(JSON.stringify({ event, inspection: evidence })).slice(0, 6000)}\n\nAcceptance test:\n${sanitizeEvidence(input.acceptanceTest)}`;
        const state = this.deps.createBug(
          sanitizeEvidence(input.title),
          sanitizeEvidence(input.summary),
          description,
          signature,
        );
        taskId = state.task.id;
        store.operator.filed(taskId, signature, this.deps.now());
        if (config.operator.autoFix.includes(event.kind as "pass_failed")) {
          store.enqueueInput(state.task.id, {
            id: `operator:autofix:${taskId}` as InputId,
            receivedAt: this.deps.now(),
            type: "human",
            command: { type: "move", to: "todo" },
          });
          this.deps.enqueue(state.task.id);
        }
      }
      this.note(
        event,
        "bug.file",
        "filed",
        `${signature}\n${event.message}`,
        false,
        taskId,
      );
      store.operator.complete(event.id, this.deps.now());
      return { accepted: true, taskId, signature };
    });
  }
}
