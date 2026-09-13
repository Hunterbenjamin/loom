// One coordinator-owned interactive session. No task, run, stage or reconciler state.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  McpServerEntry,
  PaneRef,
  ProviderSessionId,
  RunId,
  TaskId,
  WorktreePath,
} from "@loom/core";
import {
  type LeadState,
  type LeadTarget,
  leadState,
  leadTarget,
} from "@loom/protocol";
import { z } from "zod";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import { newToken } from "./derive.js";
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

export class LeadSession {
  private recipe: Recipe | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(
    private readonly deps: {
      adapters: Adapters;
      config: CoordinatorConfig;
      dataDirectory: string;
      mcpEntry(token: string): McpServerEntry;
      now(): string;
    },
  ) {
    this.directory = join(deps.dataDirectory, "lead");
  }
  get sessionId(): string | null {
    return this.recipe?.sessionId ?? null;
  }
  get mcpPort(): number {
    return this.recipe?.mcpPort ?? 0;
  }
  resolve(token: string) {
    return token && this.recipe?.token === token
      ? { kind: "lead" as const, active: !this.recipe.stopped }
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
      this.recipe.cwd !== this.deps.dataDirectory ||
      this.recipe.settingsPath !== join(this.directory, "settings.json")
    )
      throw new Error("Lead recipe belongs to a different instance directory");
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
          throw new Error("Lead requires the coordinator HTTP endpoint");
        await this.save({
          sessionId: randomUUID(),
          token,
          model: config.leadModel ?? config.models.claude,
          stopped: false,
          launched: false,
          mcpPort: Number(new URL(entry.url).port),
          cwd: this.deps.dataDirectory,
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
      const ref = pane && !pane.dead ? pane.ref : await this.launch();
      if (!this.recipe) throw new Error("Missing Lead recipe");
      await this.save({ ...this.recipe, pane: ref });
      const observation = await this.deps.adapters.paneHost.getPane(ref);
      const clients = await this.deps.adapters.paneHost.listClients(ref);
      return leadTarget.parse({
        identity: "lead",
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
          "Open Lead to recover its attach target before stopping it",
        );
      const pane = await this.pane();
      await this.save({ ...this.recipe, stopped: true });
      if (pane) await this.deps.adapters.paneHost.closePane(pane.ref);
    });
  }
  async state(): Promise<LeadState> {
    if (!this.recipe || this.recipe.stopped)
      return { id: "lead", sessionId: null, status: "stopped" };
    const sessions = await this.deps.adapters.claude
      .listSessions()
      .catch(() => []);
    const session = sessions.find(
      (s) =>
        s.sessionId === this.recipe?.sessionId && s.cwd === this.recipe.cwd,
    );
    return leadState.parse({
      id: "lead",
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
    if (!recipe) throw new Error("Missing Lead recipe");
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
      readOnly: false,
    });
    args.push(leadBrief());
    await this.save({ ...recipe, args, launched: true });
    const { workspaceId } = await this.deps.adapters.paneHost.ensureWorkspace({
      taskId: "lead" as TaskId,
      cwd: recipe.cwd as WorktreePath,
      label: "Lead",
    });
    const pane = await this.deps.adapters.paneHost.ensurePane({
      workspaceId,
      runId: "lead" as RunId,
      cwd: recipe.cwd as WorktreePath,
      executable: recipe.executable,
      args,
      env: recipe.env,
    });
    await this.save({ ...recipe, args, launched: true, pane });
    return pane;
  }
}
