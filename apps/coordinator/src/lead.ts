// Main retains internal `lead` identifiers for persisted recipes, MCP identity and clients.
// One coordinator-owned interactive session. No task, run, stage or reconciler state.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { textHash } from "@loom/adapter-claude";
import type {
  IsoTime,
  McpServerEntry,
  PaneRef,
  ProviderSessionId,
  Repo,
  RunId,
  TaskId,
  WorktreePath,
} from "@loom/core";
import { mainNoteSchema } from "@loom/mcp";
import {
  type LeadState,
  type LeadTarget,
  leadState,
  leadTarget,
} from "@loom/protocol";
import type { Store } from "@loom/store";
import { z } from "zod";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import { newToken } from "./derive.js";
import { PreconditionFailed, pressPaneChoice } from "./executor.js";
import { leadBrief } from "./prompts.js";
import { runEnvironment } from "./recipes.js";

const recipeSchema = z.strictObject({
  sessionId: z.string().uuid(),
  token: z.string().min(16),
  model: z.string().min(1),
  stopped: z.boolean(),
  launched: z.boolean(),
  mcpPort: z.number().int().min(1).max(65535),
  cwd: z.string().min(1),
  executable: z.string().min(1),
  settingsPath: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  pane: z
    .strictObject({
      hostGeneration: z.string(),
      sessionName: z.string(),
      windowId: z.string(),
      paneId: z.string(),
    })
    .nullable(),
});
type Recipe = z.output<typeof recipeSchema>;

function leadDirectory(dataDirectory: string, repoId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(repoId) || repoId === "." || repoId === "..")
    throw new Error("Invalid repository directory identity");
  return join(dataDirectory, "lead", repoId);
}

export class LeadSession {
  private recipe: Recipe | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly loggedStateErrors = new Set<string>();
  private readonly directory: string;
  constructor(
    private readonly deps: {
      adapters: Adapters;
      store: Store;
      config: CoordinatorConfig;
      dataDirectory: string;
      repo: Repo;
      mcpEntry(token: string): McpServerEntry;
      now(): IsoTime;
      log(message: string): void;
    },
  ) {
    this.directory = leadDirectory(deps.dataDirectory, deps.repo.id);
  }
  get sessionId(): string | null {
    return this.recipe?.sessionId ?? null;
  }
  get mcpPort(): number {
    return this.recipe?.mcpPort ?? 0;
  }
  resolve(token: string) {
    return token && this.recipe?.token === token
      ? {
          kind: "lead" as const,
          repoId: this.deps.repo.id,
          active: !this.recipe.stopped,
        }
      : null;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(this.directory, "recipe.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.recipe = recipeSchema.parse(JSON.parse(raw));
    if (
      this.recipe.cwd !== this.deps.repo.root ||
      this.recipe.settingsPath !== join(this.directory, "settings.json")
    )
      throw new Error("Main recipe belongs to a different instance directory");
  }
  private async save(recipe: Recipe): Promise<void> {
    const value = recipeSchema.parse(recipe);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, "recipe.tmp");
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, join(this.directory, "recipe.json"));
    this.recipe = value;
  }
  get paneRef() {
    return this.recipe?.pane ?? null;
  }
  get cwd(): WorktreePath | null {
    return (this.recipe?.cwd as WorktreePath | undefined) ?? null;
  }

  sendMessage(
    id: string,
    text: string,
    when: "now" | "after_turn" = "now",
  ): Promise<{ id: string; state: "queued" | "sent" | "refused" }> {
    return this.exclusive(async () => {
      const existing = this.deps.store.leadMessages.get(this.deps.repo.id, id);
      if (existing)
        return {
          id: existing.id,
          state:
            existing.state === "refused"
              ? "refused"
              : existing.state === "queued"
                ? "queued"
                : "sent",
        };
      const at = this.deps.now();
      this.deps.store.leadMessages.create({
        id,
        repoId: this.deps.repo.id,
        text,
        textHash: textHash(text),
        when,
        state: "queued",
        reason: null,
        createdAt: at,
        sentAt: null,
        deliveredAt: null,
      });
      const refuse = (reason: string) => {
        this.deps.store.leadMessages.update(
          this.deps.repo.id,
          id,
          "refused",
          reason,
          at,
        );
        return { id, state: "refused" as const };
      };
      if (!this.recipe || this.recipe.stopped || !this.recipe.pane)
        return refuse("Main is not running");
      const pane = await this.deps.adapters.paneHost.getPane(this.recipe.pane);
      if (!pane || pane.dead) return refuse("Main terminal is not live");
      const session = (await this.deps.adapters.claude.listSessions()).find(
        (value) =>
          value.sessionId === this.recipe?.sessionId &&
          value.cwd === this.recipe.cwd,
      );
      if (!session || session.status === "other")
        return refuse("Main status is unknown");
      if (session.status === "waiting")
        return refuse("Main is waiting on a permission; answer it first");
      if (when === "after_turn" && session.status === "busy")
        return { id, state: "queued" as const };
      await this.deps.adapters.paneHost.pasteText(this.recipe.pane, text);
      this.deps.store.leadMessages.update(
        this.deps.repo.id,
        id,
        "sent",
        null,
        at,
      );
      return { id, state: "sent" };
    });
  }

  /** Sends one queued message now, while Main's turn runs; Claude takes it as input mid-turn. */
  steerMessage(id: string): Promise<{ id: string; state: "sent" | "refused" }> {
    return this.exclusive(async () => {
      const message = this.deps.store.leadMessages.get(this.deps.repo.id, id);
      if (!message || message.state !== "queued")
        throw new PreconditionFailed("Only a queued message can steer");
      const at = this.deps.now();
      if (!this.recipe?.pane || this.recipe.stopped) {
        this.deps.store.leadMessages.update(
          this.deps.repo.id,
          id,
          "refused",
          "Main is not running",
          at,
        );
        return { id, state: "refused" as const };
      }
      const pane = await this.deps.adapters.paneHost.getPane(this.recipe.pane);
      if (!pane || pane.dead)
        throw new PreconditionFailed("Main terminal is not live");
      await this.deps.adapters.paneHost.pasteText(
        this.recipe.pane,
        message.text,
      );
      this.deps.store.leadMessages.update(
        this.deps.repo.id,
        id,
        "sent",
        null,
        at,
      );
      return { id, state: "sent" as const };
    });
  }

  flushQueued(): Promise<void> {
    return this.exclusive(async () => {
      const message = this.deps.store.leadMessages
        .list(this.deps.repo.id)
        .find((value) => value.state === "queued");
      if (!message || !this.recipe?.pane || this.recipe.stopped) return;
      const state = await this.state();
      if (state.status !== "idle") return;
      const pane = await this.deps.adapters.paneHost.getPane(this.recipe.pane);
      if (!pane || pane.dead) return;
      await this.deps.adapters.paneHost.pasteText(
        this.recipe.pane,
        message.text,
      );
      this.deps.store.leadMessages.update(
        this.deps.repo.id,
        message.id,
        "sent",
        null,
        this.deps.now(),
      );
    });
  }

  confirmMessages(
    observedHooks?: Awaited<ReturnType<Adapters["claude"]["hookSummary"]>>,
  ): Promise<void> {
    return this.exclusive(async () => {
      const recipe = this.recipe;
      if (!recipe || recipe.stopped) return;
      const messages = this.deps.store.leadMessages
        .list(this.deps.repo.id)
        .filter(
          (message) =>
            (message.state === "sent" || message.state === "failed") &&
            message.sentAt,
        );
      if (!messages.length) return;
      const now = this.deps.now();
      const hooks =
        observedHooks ??
        (await this.deps.adapters.claude.hookSummary(
          recipe.sessionId as ProviderSessionId,
        ));
      let status: LeadState["status"] | null = null;
      for (const message of messages) {
        const sentAt = message.sentAt as IsoTime;
        let receipt = hooks.promptSubmits.find(
          (prompt) =>
            prompt.textHash === message.textHash && prompt.at >= sentAt,
        );
        receipt ??=
          (await this.deps.adapters.claude.promptReceipt({
            sessionId: recipe.sessionId as ProviderSessionId,
            cwd: recipe.cwd as WorktreePath,
            textHash: message.textHash,
            after: sentAt,
            before: now,
          })) ?? undefined;
        if (receipt) {
          this.deps.store.leadMessages.update(
            this.deps.repo.id,
            message.id,
            "delivered",
            null,
            receipt.at,
          );
          continue;
        }
        if (
          message.state === "sent" &&
          Date.parse(now) - Date.parse(sentAt) >=
            this.deps.config.deliveryTimeoutMs
        ) {
          status ??= (await this.state()).status;
          if (status === "idle") {
            const seconds = Math.ceil(
              this.deps.config.deliveryTimeoutMs / 1_000,
            );
            this.deps.store.leadMessages.fail(
              this.deps.repo.id,
              message.id,
              `Claude did not receive it within ${seconds}s; check Main's terminal`,
            );
          }
        }
      }
    });
  }

  interrupt(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.recipe?.pane || this.recipe.stopped)
        throw new PreconditionFailed("Main is not running");
      if ((await this.state()).status !== "working")
        throw new PreconditionFailed("Main is not working");
      const pane = await this.deps.adapters.paneHost.getPane(this.recipe.pane);
      if (!pane || pane.dead)
        throw new PreconditionFailed("Main terminal is not live");
      await this.deps.adapters.paneHost.sendKey(this.recipe.pane, "Escape");
    });
  }

  answerPrompt(
    expected: { requestId?: string; at: string },
    choice: number | "enter" | "escape",
  ): Promise<void> {
    return this.exclusive(async () => {
      if (!this.recipe?.pane || this.recipe.stopped)
        throw new PreconditionFailed("Main is not running");
      const state = await this.state();
      const hooks = await this.deps.adapters.claude.hookSummary(
        this.recipe.sessionId as ProviderSessionId,
      );
      const dialog = hooks.pendingDialog;
      if (
        state.status !== "waiting" ||
        !dialog ||
        dialog.at !== expected.at ||
        dialog.requestId !== expected.requestId
      )
        throw new PreconditionFailed("Main prompt is no longer current");
      await pressPaneChoice(
        this.deps.adapters.paneHost,
        this.recipe.pane,
        choice,
      );
    });
  }

  async note(): Promise<string> {
    try {
      return mainNoteSchema.parse(
        await readFile(join(this.directory, "main-notes"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  setNote(note: string): Promise<{ recorded: true }> {
    return this.exclusive(async () => {
      const value = mainNoteSchema.parse(note);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, "main-notes");
      await writeFile(`${path}.tmp`, value, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return { recorded: true };
    });
  }

  private async pane() {
    const recipe = this.recipe;
    if (!recipe) return null;
    if (recipe.pane) {
      const observed = await this.deps.adapters.paneHost.getPane(recipe.pane);
      if (observed && observed.startCwd === recipe.cwd) return observed;
    }
    // The workspace also contains a human shell. Cwd alone must never adopt it.
    // An explicit open can recover a lost launch receipt through ensurePane's owned key.
    return null;
  }

  async recover(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.recipe) return;
      const pane = await this.pane();
      if (this.recipe.stopped) {
        if (pane) await this.deps.adapters.paneHost.closePane(pane.ref);
        return;
      }
      await this.settings();
      // Absence could be an intentional close. Only a confirmed dead pane is relaunched.
      if (pane?.dead) await this.launch();
    });
  }
  open(): Promise<LeadTarget> {
    return this.exclusive(async () => {
      if (this.recipe?.stopped) {
        const previous = await this.pane();
        if (previous) await this.deps.adapters.paneHost.closePane(previous.ref);
      }
      if (!this.recipe || this.recipe.stopped) {
        const config = this.deps.config;
        const token = newToken();
        const entry = this.deps.mcpEntry(token);
        if (!("type" in entry) || entry.type !== "http")
          throw new Error("Main requires the coordinator HTTP endpoint");
        await this.save({
          sessionId: randomUUID(),
          token,
          model: config.leadModel ?? config.models.claude,
          stopped: false,
          launched: false,
          mcpPort: Number(new URL(entry.url).port),
          cwd: this.deps.repo.root,
          executable: config.claudeExecutable,
          settingsPath: join(this.directory, "settings.json"),
          args: [],
          env: runEnvironment(process.env, {
            LOOM_INSTANCE: config.instance,
            LOOM_MCP_TOKEN: token,
          }),
          pane: null,
        });
      }
      const pane = await this.pane();
      // Opening the conversation is looking, not asking (decision 2026-09-13): a live Main gets
      // no prompt on open. Only a first launch speaks, with its introduction.
      const ref = pane && !pane.dead ? pane.ref : await this.launch();
      if (!this.recipe) throw new Error("Missing Main recipe");
      await this.save({ ...this.recipe, pane: ref });
      const observation = await this.deps.adapters.paneHost.getPane(ref);
      const clients = await this.deps.adapters.paneHost.listClients(ref);
      return leadTarget.parse({
        identity: "lead",
        repoId: this.deps.repo.id,
        sessionId: this.recipe.sessionId,
        attach: {
          kind: "pane_host",
          argv: this.deps.adapters.paneHost.attachArgs(ref),
          cwd: this.recipe.cwd,
          env: {},
        },
        pane: observation
          ? {
              ...ref,
              dead: observation.dead,
              exitStatus: observation.exitCode,
              attachedClients: clients.length,
              size: clients[0]
                ? { cols: clients[0].cols, rows: clients[0].rows }
                : null,
              observedAt: this.deps.now(),
            }
          : null,
      });
    });
  }
  stop(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.recipe) return;
      if (this.recipe.launched && !this.recipe.pane)
        throw new Error(
          "Open Main to recover its attach target before stopping it",
        );
      const pane = await this.pane();
      await this.save({ ...this.recipe, stopped: true });
      if (pane) await this.deps.adapters.paneHost.closePane(pane.ref);
    });
  }
  async state(): Promise<LeadState> {
    if (!this.recipe || this.recipe.stopped)
      return { id: this.deps.repo.id, sessionId: null, status: "stopped" };
    let sessions: Awaited<ReturnType<Adapters["claude"]["listSessions"]>>;
    let reason: string | null = null;
    try {
      sessions = await this.deps.adapters.claude.listSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reason = `claude agents --json failed: ${message}`;
      if (!this.loggedStateErrors.has(reason)) {
        this.loggedStateErrors.add(reason);
        this.deps.log(`Main status unavailable: ${reason}`);
      }
      sessions = [];
    }
    const session = sessions.find(
      (s) =>
        s.sessionId === this.recipe?.sessionId && s.cwd === this.recipe.cwd,
    );
    return leadState.parse({
      id: this.deps.repo.id,
      sessionId: this.recipe.sessionId,
      reason,
      status:
        session?.status === "busy"
          ? "working"
          : session?.status === "waiting"
            ? "waiting"
            : session?.status === "idle"
              ? "idle"
              : "unknown",
    });
  }
  private async settings() {
    if (this.recipe)
      await this.deps.adapters.claude.writeSettings(
        this.recipe.settingsPath,
        this.deps.mcpEntry(this.recipe.token),
      );
  }
  private async launch(): Promise<PaneRef> {
    const recipe = this.recipe;
    if (!recipe) throw new Error("Missing Main recipe");
    await this.settings();
    // A launch can die before a transcript exists. Ask the provider whether this ID resumes.
    const resume =
      recipe.launched &&
      (await this.deps.adapters.claude.resumable(
        recipe.sessionId as ProviderSessionId,
        recipe.cwd as WorktreePath,
      ));
    const args = this.deps.adapters.claude.interactiveArgs({
      sessionId: recipe.sessionId as ProviderSessionId,
      resume,
      model: recipe.model,
      settingsPath: recipe.settingsPath,
      // Main is the brain with hands (decision 2026-09-13): the same access the human has.
      readOnly: false,
    });
    args.push(
      "--name",
      "Main",
      "--",
      leadBrief(await this.note(), this.deps.repo.github),
    );
    await this.save({ ...recipe, args, launched: true });
    const { workspaceId } = await this.deps.adapters.paneHost.ensureWorkspace({
      taskId: `lead-${this.deps.repo.id}` as TaskId,
      cwd: recipe.cwd as WorktreePath,
      label: "Main",
    });
    const pane = await this.deps.adapters.paneHost.ensurePane({
      workspaceId,
      runId: `lead-${this.deps.repo.id}` as RunId,
      cwd: recipe.cwd as WorktreePath,
      executable: recipe.executable,
      args,
      env: recipe.env,
    });
    await this.save({ ...recipe, args, launched: true, pane });
    return pane;
  }
}
