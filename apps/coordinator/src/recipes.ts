// Principle 7 and design §5.3: everything needed to launch — or relaunch — a run is written down
// before anything starts. A recipe lives outside the repository, in the instance's data directory,
// with mode 0600, because it carries the run's MCP token. Its directory also holds the run's
// Claude settings and MCP config, which are part of that session's identity.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Provider,
  ProviderSessionId,
  Role,
  RunId,
  RunMode,
  TaskId,
  WorktreePath,
} from "@loom/core";
import { z } from "zod";

/**
 * The complete environment a pane process may see (spike 06 §3). The host removes every inherited
 * name this list omits, which is what keeps `CLAUDE_CODE_CHILD_SESSION` out: inheriting it turns
 * off transcript saving in Claude agents, and that breaks resuming (principle 7).
 */
export const ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

const recipeSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  role: z.enum(["planner", "implementer", "reviewer"]),
  provider: z.enum(["codex", "claude"]),
  mode: z.enum(["headless", "interactive"]),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  access: z.enum(["full", "approval-gated"]).optional(),
  attempt: z.number().int().positive(),
  sessionEpoch: z.number().int().nonnegative(),
  /** Recorded before launch. Null only until a Codex `thread/start` assigns one. */
  sessionId: z.string().min(1).nullable(),
  cwd: z.string().min(1),
  /** Unguessable, per run. Never derived from an ID, and never in argv. */
  token: z.string().min(16),
  /** Claude only. Written beside each other: the MCP config has the token, the settings don't. */
  settingsPath: z.string().min(1).nullable(),
  mcpConfigPath: z.string().min(1).nullable(),
  /** The interactive launch command, so a dead pane can be recreated exactly (design §10). */
  executable: z.string().min(1).nullable(),
  args: z.array(z.string()),
  env: z.record(z.string().min(1), z.string()),
  /** The role brief the run was launched with, so a relaunch says the same thing. */
  prompt: z.string(),
  createdAt: z.string().min(1),
});

type StoredRecipe = z.output<typeof recipeSchema>;

export interface LaunchRecipe extends StoredRecipe {
  runId: RunId;
  taskId: TaskId;
  role: Role;
  provider: Provider;
  mode: RunMode;
  sessionId: ProviderSessionId | null;
  cwd: WorktreePath;
}

const slug = (runId: string): string =>
  Buffer.from(runId, "utf8").toString("base64url");

/**
 * What every pane Loom starts gets besides the allowlist. Claude Code's fullscreen renderer
 * draws on the alternate screen, which leaves the pane host no scrollback for the transcript
 * and gives a viewer two scroll positions; its classic renderer prints the transcript into the
 * pane, where the Workbench replays it (docs/design/ui.md, "Terminals").
 */
const PANE_ENVIRONMENT: Record<string, string> = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
};

/** Builds the child environment from the allowlist plus the names Loom adds itself. */
export function runEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...PANE_ENVIRONMENT, ...extra };
}

export class RecipeStore {
  readonly root: string;
  private readonly byRun = new Map<string, LaunchRecipe>();
  private readonly byToken = new Map<string, LaunchRecipe>();
  constructor(dataDirectory: string) {
    this.root = join(dataDirectory, "runs");
  }
  /** Where a run's private files live. Outside the repository, and never inside a worktree. */
  directory(runId: RunId): string {
    return join(this.root, slug(runId));
  }
  /** Reads every recipe written by an earlier coordinator. Called once, at startup. */
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(this.root, entry.name, "recipe.json");
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      this.remember(recipeSchema.parse(JSON.parse(raw)) as LaunchRecipe);
    }
  }
  async save(recipe: LaunchRecipe): Promise<LaunchRecipe> {
    const value = recipeSchema.parse(recipe) as LaunchRecipe;
    const directory = this.directory(value.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "recipe.json"),
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    this.remember(value);
    return value;
  }
  get(runId: RunId): LaunchRecipe | null {
    return this.byRun.get(runId) ?? null;
  }
  /** Consulted on every MCP call; the caller still rechecks the run's liveness in the store. */
  resolve(token: string): LaunchRecipe | null {
    return token ? (this.byToken.get(token) ?? null) : null;
  }
  all(): LaunchRecipe[] {
    return [...this.byRun.values()];
  }
  async forget(runId: RunId): Promise<void> {
    const existing = this.byRun.get(runId);
    if (existing) this.byToken.delete(existing.token);
    this.byRun.delete(runId);
    await rm(this.directory(runId), { recursive: true, force: true });
  }
  private remember(recipe: LaunchRecipe): void {
    const previous = this.byRun.get(recipe.runId);
    if (previous) this.byToken.delete(previous.token);
    this.byRun.set(recipe.runId, recipe);
    this.byToken.set(recipe.token, recipe);
  }
}
