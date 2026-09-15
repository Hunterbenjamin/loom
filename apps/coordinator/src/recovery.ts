// Startup recovery (brief §7, design §10). The coordinator restarting changes nothing outside
// Loom: providers and the pane host are untouched. What is uncertain is the handful of actions
// that were running when it died, so each one's owner is asked before anything runs again.
//
// `store.outbox.startupRunning` never replays on its own. Every row here is either recorded with
// the result the owner proves, or requeued for the executor to run again.

import type { ActionResult, InputId, Repo, RunId, TaskId } from "@loom/core";
import type { RunningAction, Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import type { LaunchDeps } from "./launch.js";
import { codexThreadConfig, relaunchFromRecipe } from "./launch.js";
import type { RecipeStore } from "./recipes.js";

interface RecoveryDeps {
  store: Store;
  adapters: Adapters;
  recipes: RecipeStore;
  launch: LaunchDeps;
  repo(taskId: TaskId): Repo;
  now(): string;
  nextInputId(): InputId;
  log(message: string): void;
}

const TERMINAL = ["done", "canceled"];

/**
 * What the owner says about one uncertain action. `null` means the owner cannot prove the effect
 * happened, so the intent is requeued: actions are at-least-once and every executor is idempotent.
 */
export async function recoverAction(
  deps: RecoveryDeps,
  running: RunningAction,
): Promise<ActionResult | null> {
  const action = running.entry.action;
  if (!action) return null;
  const state = deps.store.loadTaskState(running.taskId);
  try {
    switch (action.kind) {
      case "create_worktree": {
        const observation = await deps.adapters.git.readWorktree(
          action.path as never,
          action.baseBranch,
        );
        if (!observation.exists || !observation.headSha) return null;
        return {
          kind: "create_worktree",
          ok: true,
          output: {
            path: observation.path,
            headSha: observation.headSha,
            baseSha: state.worktree?.baseSha ?? observation.headSha,
          },
        };
      }
      case "push_branch": {
        const observation = await deps.adapters.git.readWorktree(
          action.worktreePath,
          state.worktree?.baseBranch ?? "main",
        );
        return observation.remoteHeadSha === action.expectedHeadSha
          ? {
              kind: "push_branch",
              ok: true,
              output: { remoteHeadSha: action.expectedHeadSha },
            }
          : null;
      }
      case "open_pr": {
        const repo = deps.repo(running.taskId);
        const found = await deps.adapters.github.findPullRequest({
          repo: repo.github,
          branch: action.branch,
          etag: null,
        });
        const pr = found.notModified ? null : found.value;
        return pr
          ? {
              kind: "open_pr",
              ok: true,
              output: { number: pr.number, url: pr.url },
            }
          : null;
      }
      case "merge_pr": {
        const repo = deps.repo(running.taskId);
        const found = await deps.adapters.github.findPullRequest({
          repo: repo.github,
          branch: state.task.branch ?? "",
          etag: null,
        });
        const pr = found.notModified ? null : found.value;
        if (pr?.state === "merged")
          return { kind: "merge_pr", ok: true, output: { state: "merged" } };
        if (pr?.autoMergeEnabled)
          return {
            kind: "merge_pr",
            ok: true,
            output: { state: "auto_merge_enabled" },
          };
        return null;
      }
      case "start_run": {
        // A session already live under this ID is the run: adopt it rather than starting a second.
        const recipe = deps.recipes.get(action.runId);
        const sessionId = recipe?.sessionId ?? action.sessionId;
        if (!sessionId) return null;
        if (action.provider === "claude") {
          const sessions = await deps.adapters.claude.listSessions();
          if (!sessions.some((s) => s.sessionId === sessionId)) return null;
          return {
            kind: "start_run",
            ok: true,
            output: {
              sessionId,
              codexGeneration: null,
              pane: state.runs.find((r) => r.id === action.runId)?.pane ?? null,
            },
          };
        }
        const codex = await deps.adapters.codex(running.taskId);
        const snapshot = await codex.readThread(sessionId);
        return {
          kind: "start_run",
          ok: true,
          output: {
            sessionId,
            codexGeneration: snapshot.generation,
            pane: state.runs.find((r) => r.id === action.runId)?.pane ?? null,
          },
        };
      }
      default:
        return null;
    }
  } catch (error) {
    deps.log(
      `Could not recover ${action.kind} ${running.entry.key}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export interface RecoveryReport {
  interrupted: RunId[];
  recorded: string[];
  requeued: string[];
  resumedCodex: string[];
  relaunched: string[];
  reconciled: TaskId[];
}

/** The whole startup sequence. Returns what it did, so `loom serve` can say so on stderr. */
export async function recover(
  deps: RecoveryDeps,
  startupRunning: readonly RunningAction[],
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    interrupted: [],
    recorded: [],
    requeued: [],
    resumedCodex: [],
    relaunched: [],
    reconciled: [],
  };
  const tasks = deps.store.tasks();
  // Persisted provider facts must be captured before the first post-restart observation can
  // replace them. The deterministic identity makes repeated recovery safe.
  for (const task of tasks) {
    if (TERMINAL.includes(task.stage)) continue;
    const state = deps.store.loadTaskState(task.id);
    for (const run of state.runs) {
      if (
        run.origin !== "loom" ||
        run.endedAt ||
        !run.sessionId ||
        !run.inFlightTurnId
      )
        continue;
      const id = `restart_interrupted:${run.id}:${run.inFlightTurnId}`;
      if (deps.store.hasInput(id)) continue;
      deps.store.enqueueInput(task.id, {
        id: id as InputId,
        receivedAt: deps.now() as never,
        type: "coordinator",
        event: {
          type: "restart_interrupted",
          runId: run.id,
          turnId: run.inFlightTurnId,
        },
      });
      report.interrupted.push(run.id);
    }
  }
  for (const running of startupRunning) {
    const result = await recoverAction(deps, running);
    if (result) {
      deps.store.outbox.finish(running.entry.key, running.entry.claimVersion, {
        id: deps.nextInputId(),
        receivedAt: deps.now() as never,
        type: "action_result",
        key: running.entry.key,
        result,
      });
      report.recorded.push(running.entry.key);
    } else if (
      deps.store.outbox.requeue(running.entry.key, running.entry.claimVersion)
    )
      report.requeued.push(running.entry.key);
  }

  // Rewrite settings files for all non-ended Claude runs so they pick up stable ports on restart.
  // Skip terminal tasks (done/canceled) as they have no active runs and no app-servers should be started.
  for (const task of tasks) {
    if (TERMINAL.includes(task.stage)) continue;
    const state = deps.store.loadTaskState(task.id);
    for (const run of state.runs) {
      if (run.endedAt || run.provider !== "claude" || !run.sessionId) continue;
      const recipe = deps.recipes.get(run.id);
      if (!recipe?.settingsPath) continue;
      try {
        await deps.adapters.claude.writeSettings(
          recipe.settingsPath,
          deps.launch.mcpEntry(recipe.token),
        );
      } catch (error) {
        deps.log(
          `Could not rewrite settings for ${run.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  // Resume active Codex runs and relaunch panes for non-terminal tasks.
  // Terminal tasks (done/canceled) are skipped: no app-servers are started for them (design §10).
  for (const task of tasks) {
    if (TERMINAL.includes(task.stage)) continue;
    const state = deps.store.loadTaskState(task.id);
    for (const run of state.runs) {
      if (run.endedAt || run.origin !== "loom" || !run.sessionId) continue;
      if (run.provider === "codex") {
        // A Codex turn in flight survived, because its app-server lives outside the pane host.
        try {
          const codex = await deps.adapters.codex(task.id);
          const recipe = deps.recipes.get(run.id);
          await codex.resumeThread(
            run.sessionId,
            recipe
              ? {
                  config: codexThreadConfig(
                    deps.launch.mcpEntry(recipe.token),
                    run.reasoningEffort,
                  ),
                }
              : undefined,
          );
          report.resumedCodex.push(run.id);
        } catch (error) {
          deps.log(
            `Could not resume Codex thread for ${run.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (run.mode !== "interactive" || !run.pane) continue;
      const recipe = deps.recipes.get(run.id);
      if (!recipe || !state.worktree?.paneWorkspaceId) continue;
      try {
        // Only a confirmed missing/dead recorded pane permits relaunch. An observation error
        // is uncertainty, not permission to launch a second agent.
        const pane = await deps.adapters.paneHost.getPane(run.pane);
        if (pane && !pane.dead) continue;
        const { workspaceId } = await deps.adapters.paneHost.ensureWorkspace({
          taskId: task.id,
          cwd: state.worktree.path,
          label: task.title,
        });
        const newPane = await relaunchFromRecipe(
          deps.launch,
          recipe,
          workspaceId,
        );
        // Persist the new pane info before any pane operation targets it.
        deps.store.updateRunPane(task.id, run.id, newPane);
        report.relaunched.push(run.id);
      } catch (error) {
        deps.log(
          `Could not relaunch ${run.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    report.reconciled.push(task.id);
  }
  // `claude agents --json` owns live status; one poll here seeds it before the first pass.
  await deps.adapters.claude.listSessions().catch(() => []);
  return report;
}
