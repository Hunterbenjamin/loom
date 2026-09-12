// Starting a run (brief §3). The whole recipe is persisted before anything starts: the derived
// session ID, the run's MCP token, its settings and MCP config files, the environment allowlist,
// the cwd, the executable and its arguments. Only then does anything outside Loom happen.
//
// `start_run` is at-least-once (design §5.4), so every path here adopts an existing session under
// the same ID instead of starting a second one.

import type {
  ActionOutputs,
  McpServerEntry,
  Role,
  TaskState,
} from "@loom/core";
import { mcpConfigPathFor } from "@loom/adapter-claude";
import { join } from "node:path";
import type { Action } from "@loom/core";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import { newToken } from "./derive.js";
import { roleBrief } from "./prompts.js";
import { type LaunchRecipe, RecipeStore, runEnvironment } from "./recipes.js";

export type StartRunAction = Extract<Action, { kind: "start_run" }>;

export interface LaunchDeps {
  adapters: Adapters;
  config: CoordinatorConfig;
  recipes: RecipeStore;
  /** The run's MCP registration, built from the coordinator's own loopback endpoint. */
  mcpEntry(token: string): McpServerEntry;
  now(): string;
  environment?: NodeJS.ProcessEnv;
}

const READ_ONLY: Role[] = ["planner", "reviewer"];

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
    await adapters.claude.writeSettings(settingsPath, deps.mcpEntry(token));
    const sessionId = action.sessionId;
    if (!sessionId) throw new Error("A Claude run must know its session ID before launch");
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
    });
    const pane = await openPane(deps, state, action, {
      ...recipe,
      executable: config.claudeExecutable,
      args,
    });
    return { sessionId, codexGeneration: null, pane };
  }

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
      sandbox: READ_ONLY.includes(action.role) ? "read-only" : "workspace-write",
      developerInstructions: prompt,
      config: { mcp_servers: { loom: deps.mcpEntry(token) } },
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
  if (!executable) throw new Error("The Codex adapter returned no attach command");
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

