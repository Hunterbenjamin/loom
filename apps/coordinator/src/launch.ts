// Starting a run (brief §3). The whole recipe is persisted before anything starts: the derived
// session ID, the run's MCP token, its settings and MCP config files, the environment allowlist,
// the cwd, the executable and its arguments. Only then does anything outside Loom happen.
//
// `start_run` is at-least-once (design §5.4), so every path here adopts an existing session under
// the same ID instead of starting a second one.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpConfigPathFor } from "@loom/adapter-claude";
import { codexMcpServer } from "@loom/adapter-codex";
import type {
  Action,
  ActionOutputs,
  McpServerEntry,
  Role,
  TaskState,
} from "@loom/core";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import { newToken } from "./derive.js";
import { roleBrief } from "./prompts.js";
import {
  type LaunchRecipe,
  type RecipeStore,
  runEnvironment,
} from "./recipes.js";
import type { WorkflowReader } from "./workflow.js";

export type StartRunAction = Extract<Action, { kind: "start_run" }>;

export interface LaunchDeps {
  adapters: Adapters;
  config: CoordinatorConfig;
  recipes: RecipeStore;
  /** The run's MCP registration, built from the coordinator's own loopback endpoint. */
  mcpEntry(token: string): McpServerEntry;
  now(): string;
  environment?: NodeJS.ProcessEnv;
  /** Reads WORKFLOW.md for interactive Claude runs to derive bash command prefixes. */
  workflowReader?: WorkflowReader;
  /** Resolves a RepoId to its Repo, for reading WORKFLOW.md from the repo root. */
  repoById?: (repoId: string) => { root: string } | undefined;
  /** The instance data directory; a task's Codex home is `codex/<task>/codex-home` under it. */
  dataDirectory?: string;
}

/**
 * The Codex TUI that Loom attaches with `codex resume --remote` reads `CODEX_HOME/config.toml`,
 * not the overrides `thread/start` was given: with an empty per-task config it ran in the
 * workspace-write sandbox (no `.git` writes), asked for approvals, and had no Loom MCP tools
 * (2026-09-13). The file is rewritten on every launch so the run's token is
 * the current one; it holds a secret, so mode 0600.
 */
export async function writeCodexHomeConfig(
  dataDirectory: string,
  action: StartRunAction,
  entry: McpServerEntry,
): Promise<void> {
  if (!("url" in entry)) return;
  const home = join(dataDirectory, "codex", action.taskId, "codex-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const headers = Object.entries(entry.headers ?? {})
    .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join(", ");
  const access = action.access ?? "full";
  const sandbox = READ_ONLY.includes(action.role)
    ? "read-only"
    : access === "approval-gated"
      ? "workspace-write"
      : "danger-full-access";
  const lines = [
    `model = ${JSON.stringify(action.model)}`,
    ...(action.reasoningEffort
      ? [`model_reasoning_effort = ${JSON.stringify(action.reasoningEffort)}`]
      : []),
    `approval_policy = ${JSON.stringify(access === "approval-gated" ? "on-request" : "never")}`,
    `sandbox_mode = ${JSON.stringify(sandbox)}`,
    "",
    "[mcp_servers.loom]",
    `url = ${JSON.stringify(entry.url)}`,
    `http_headers = { ${headers} }`,
    "",
  ];
  await writeFile(join(home, "config.toml"), lines.join("\n"), { mode: 0o600 });
}

const READ_ONLY: Role[] = ["planner"];

/** Fixed allowlist of bash command prefixes for interactive Claude runs. */
export const FIXED_BASH_PREFIXES = [
  "git add",
  "git commit",
  "git status",
  "git diff",
  "git log",
  "pnpm install",
  "pnpm exec vitest",
  "pnpm exec biome",
  "pnpm exec tsc",
];

/**
 * Derives bash command prefixes for an interactive Claude run.
 * Combines fixed prefixes with commands derived from WORKFLOW.md.
 */
export async function deriveBashPrefixes(
  state: TaskState,
  workflowReader?: WorkflowReader,
  repoById?: (repoId: string) => { root: string } | undefined,
): Promise<string[]> {
  const prefixes = [...FIXED_BASH_PREFIXES];

  if (!workflowReader || !repoById) return prefixes;

  try {
    const repo = repoById(state.task.repoId);
    if (!repo) return prefixes;

    const commands = await workflowReader.read(repo.root);
    // Convert WORKFLOW.md command names to bash prefixes
    // E.g., "test" from `## test` → "pnpm test"
    for (const name of Object.keys(commands)) {
      // For now, assume all commands are pnpm-based
      const prefix = `pnpm ${name}`;
      if (!prefixes.includes(prefix)) {
        prefixes.push(prefix);
      }
    }
  } catch {
    // If reading WORKFLOW.md fails, just use the fixed prefixes
  }

  return prefixes;
}

/** The brief a run is launched with. Short on purpose: `get_task_context` holds the rest. */
export function launchPrompt(state: TaskState, action: StartRunAction): string {
  const run = state.runs.find((r) => r.id === action.runId);
  return roleBrief({
    task: state.task,
    role: action.role,
    round: run?.round ?? 0,
    branch: state.worktree?.branch ?? state.task.branch ?? "(no branch)",
    worktreePath: action.worktreePath,
  });
}

/**
 * Writes the recipe, then launches. The recipe is saved twice for Codex: once before
 * `thread/start`, so a crash mid-launch leaves a token and a directory behind that the next
 * attempt reuses, and once after, to record the thread ID the server assigned (principle 7).
 */
export async function startRun(
  deps: LaunchDeps,
  action: StartRunAction,
  state: TaskState,
): Promise<ActionOutputs["start_run"]> {
  const { adapters, config, recipes } = deps;
  const access = action.access ?? "full";
  const previous = recipes.get(action.runId);
  const token =
    previous && previous.sessionEpoch === action.sessionEpoch
      ? previous.token
      : newToken();
  const directory = recipes.directory(action.runId);
  const settingsPath =
    action.provider === "claude" ? join(directory, "settings.json") : null;
  const prompt = launchPrompt(state, action);
  const env = runEnvironment(deps.environment ?? process.env, {
    LOOM_MCP_TOKEN: token,
    LOOM_INSTANCE: config.instance,
    LOOM_TASK_ID: action.taskId,
    LOOM_RUN_ID: action.runId,
  });

  let recipe: LaunchRecipe = await recipes.save({
    runId: action.runId,
    taskId: action.taskId,
    role: action.role,
    provider: action.provider,
    mode: action.mode,
    model: action.model,
    ...(action.reasoningEffort
      ? { reasoningEffort: action.reasoningEffort }
      : {}),
    access,
    attempt: action.attempt,
    sessionEpoch: action.sessionEpoch,
    sessionId: action.sessionId,
    cwd: action.worktreePath,
    token,
    settingsPath,
    mcpConfigPath: settingsPath ? mcpConfigPathFor(settingsPath) : null,
    executable: null,
    args: [],
    env,
    prompt,
    createdAt: deps.now(),
  });

  if (action.provider === "claude") {
    if (!settingsPath) throw new Error("A Claude run needs a settings path");
    // `--settings` is part of a Claude session's identity: whatever relaunches the run must pass
    // it again. The token goes in the sibling MCP config, never in the settings file.
    // For interactive runs, derive bash command prefixes from WORKFLOW.md.
    let bashPrefixes: string[] | undefined;
    if (action.mode === "interactive" && access === "full") {
      bashPrefixes = await deriveBashPrefixes(
        state,
        deps.workflowReader,
        deps.repoById,
      );
    }
    await adapters.claude.writeSettings(
      settingsPath,
      deps.mcpEntry(token),
      bashPrefixes,
    );
    const sessionId = action.sessionId;
    if (!sessionId)
      throw new Error("A Claude run must know its session ID before launch");
    if (action.mode === "headless") {
      await adapters.claude.startHeadless({
        sessionId,
        resume: action.resume,
        cwd: action.worktreePath,
        model: action.model,
        settingsPath,
        readOnly: READ_ONLY.includes(action.role),
        prompt,
      });
      return { sessionId, codexGeneration: null, pane: null };
    }
    const args = adapters.claude.interactiveArgs({
      sessionId,
      resume: action.resume,
      model: action.model,
      settingsPath,
      readOnly: READ_ONLY.includes(action.role),
      approvalGated: access === "approval-gated",
    });
    const pane = await openPane(deps, state, action, {
      ...recipe,
      executable: config.claudeExecutable,
      args,
    });
    return { sessionId, codexGeneration: null, pane };
  }

  if (deps.dataDirectory)
    await writeCodexHomeConfig(
      deps.dataDirectory,
      action,
      deps.mcpEntry(token),
    );
  const codex = await adapters.codex(action.taskId);
  // A repeated `start_run` must adopt the recorded thread, not open a second one.
  let threadId = action.sessionId;
  let generation = codex.generation();
  if (threadId && action.resume) {
    const snapshot = await codex.resumeThread(threadId);
    generation = snapshot.generation;
  } else if (threadId) {
    const snapshot = await codex.readThread(threadId);
    generation = snapshot.generation;
  } else {
    const started = await codex.startThread({
      cwd: action.worktreePath,
      model: action.model,
      // Implementers and reviewers get full access in their worktree (network included: `pnpm add` was
      // blocked by workspace-write's no-network rule); only planners stay read-only.
      sandbox: READ_ONLY.includes(action.role)
        ? "read-only"
        : access === "approval-gated"
          ? "workspace-write"
          : "danger-full-access",
      approvalPolicy: access === "approval-gated" ? "on-request" : "never",
      developerInstructions: prompt,
      config: {
        mcp_servers: { loom: codexMcpServer(deps.mcpEntry(token)) },
        ...(action.reasoningEffort
          ? { model_reasoning_effort: action.reasoningEffort }
          : {}),
      },
    });
    threadId = started.threadId;
    generation = started.generation;
    recipe = await recipes.save({ ...recipe, sessionId: threadId });
  }
  if (action.mode === "headless")
    return {
      sessionId: threadId,
      codexGeneration: generation,
      pane: null,
    };
  const [executable, ...args] = codex.attachArgs(threadId);
  if (!executable)
    throw new Error("The Codex adapter returned no attach command");
  const pane = await openPane(deps, state, action, {
    ...recipe,
    sessionId: threadId,
    executable,
    args,
  });
  return { sessionId: threadId, codexGeneration: generation, pane };
}

/** Records the full command line before the pane exists, then asks the host for the pane. */
async function openPane(
  deps: LaunchDeps,
  state: TaskState,
  action: StartRunAction,
  recipe: LaunchRecipe,
): Promise<ActionOutputs["start_run"]["pane"]> {
  const workspaceId = state.worktree?.paneWorkspaceId;
  if (!workspaceId)
    throw new Error("The task's pane workspace has not been opened yet");
  const saved = await deps.recipes.save(recipe);
  return deps.adapters.paneHost.ensurePane({
    workspaceId,
    runId: action.runId,
    cwd: action.worktreePath,
    executable: saved.executable as string,
    args: saved.args,
    env: saved.env,
  });
}

/**
 * Relaunch an interactive run whose pane died while the coordinator was down (design §10). The
 * command line comes from the recipe, never from the pane's argv, and never from a screen.
 */
export async function relaunchFromRecipe(
  deps: LaunchDeps,
  recipe: LaunchRecipe,
  workspaceId: string,
): Promise<ActionOutputs["start_run"]["pane"]> {
  if (recipe.mode !== "interactive" || !recipe.executable)
    throw new Error("Only an interactive run is relaunched from its recipe");
  return deps.adapters.paneHost.ensurePane({
    workspaceId,
    runId: recipe.runId,
    cwd: recipe.cwd,
    executable: recipe.executable,
    args: recipe.args,
    env: recipe.env,
  });
}
