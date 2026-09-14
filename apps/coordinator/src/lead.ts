// Main retains internal `lead` identifiers for persisted recipes, MCP identity and clients.
// One coordinator-owned interactive session. No task, run, stage or reconciler state.
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { textHash } from "@loom/adapter-claude";
import type {
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
  legacyCwd: z.string().optional(),
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
  private readonly directory: string;
  constructor(
    private readonly deps: {
      adapters: Adapters;
      store: Store;
      config: CoordinatorConfig;
      dataDirectory: string;
      repo: Repo;
      mcpEntry(token: string): McpServerEntry;
      now(): string;
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
  ): Promise<{ id: string; state: "sent" | "refused" }> {
    return this.exclusive(async () => {
      const existing = this.deps.store.leadMessages.get(this.deps.repo.id, id);
      if (existing)
        return {
          id: existing.id,
          state: existing.state === "refused" ? "refused" : "sent",
        };
      const at = this.deps.now();
      this.deps.store.leadMessages.create({
        id,
        repoId: this.deps.repo.id,
        text,
        textHash: textHash(text),
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
      const hooks = await this.deps.adapters.claude.hookSummary(
        this.recipe.sessionId as ProviderSessionId,
      );
      if (hooks.pendingDialog)
        return refuse("Main has a pending prompt; answer it first");
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
      if (
        observed &&
        (observed.startCwd === recipe.cwd ||
          observed.startCwd === recipe.legacyCwd)
      )
        return observed;
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
      if (this.recipe.legacyCwd && pane) {
        // Retire only the recorded legacy pane before moving this same session to its project.
        await this.deps.adapters.paneHost.closePane(pane.ref);
        await this.launch();
        return;
      }
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
    const sessions = await this.deps.adapters.claude
      .listSessions()
      .catch(() => []);
    const session = sessions.find(
      (s) =>
        s.sessionId === this.recipe?.sessionId && s.cwd === this.recipe.cwd,
    );
    return leadState.parse({
      id: this.deps.repo.id,
      sessionId: this.recipe.sessionId,
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
        (recipe.legacyCwd ?? recipe.cwd) as WorktreePath,
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
    const { legacyCwd: _, ...current } = recipe;
    await this.save({ ...current, args, launched: true, pane });
    return pane;
  }
}

/** Keep a legacy process's endpoint stable even before its first repository is registered. */
export async function legacyLeadPort(dataDirectory: string): Promise<number> {
  try {
    return recipeSchema.parse(
      JSON.parse(
        await readFile(join(dataDirectory, "lead", "recipe.json"), "utf8"),
      ),
    ).mcpPort;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Atomic destination recipe is the migration commit. The old source is retired only afterwards. */
export async function migrateLead(
  dataDirectory: string,
  repo: Repo | undefined,
): Promise<void> {
  if (!repo) return;
  const source = join(dataDirectory, "lead", "recipe.json");
  let raw: string;
  try {
    raw = await readFile(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const old = recipeSchema.parse(JSON.parse(raw));
  const directory = leadDirectory(dataDirectory, repo.id);
  const destination = join(directory, "recipe.json");
  try {
    const existing = recipeSchema.parse(
      JSON.parse(await readFile(destination, "utf8")),
    );
    if (existing.sessionId !== old.sessionId || existing.token !== old.token)
      throw new Error("Legacy Main conflicts with an existing repository Main");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (
      old.cwd !== dataDirectory ||
      old.settingsPath !== join(dataDirectory, "lead", "settings.json")
    )
      throw new Error(
        "Legacy Main recipe belongs to a different instance directory",
      );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [from, to] of [
      [
        join(dataDirectory, "lead", "settings.json"),
        join(directory, "settings.json"),
      ],
      [join(dataDirectory, "main-notes"), join(directory, "main-notes")],
    ] as const) {
      try {
        await copyFile(from, to);
        await chmod(to, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const settingsPath = join(directory, "settings.json");
    const migrated = {
      ...old,
      cwd: repo.root,
      legacyCwd: old.cwd,
      settingsPath,
      args: old.args.map((arg) =>
        arg === old.settingsPath ? settingsPath : arg,
      ),
    };
    await writeFile(
      `${destination}.tmp`,
      `${JSON.stringify(migrated, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(`${destination}.tmp`, destination);
  }
  await unlink(source);
}
