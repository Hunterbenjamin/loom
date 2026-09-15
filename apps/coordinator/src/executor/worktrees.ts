import { resolve, sep } from "node:path";
import { UnsafeWorktreePathError } from "@loom/adapter-git";
import type { Action, ArtifactKind, TaskState } from "@loom/core";
import type { Exclusive, ExecutorDeps } from "./deps.js";
import { Fatal, PreconditionFailed } from "./errors.js";

/** The `.task/` files an artifact kind becomes. Text stays text; everything else is JSON. */
const FILE_NAMES: Record<ArtifactKind, string> = {
  brief: "brief.md",
  plan: "plan.json",
  decisions: "decisions.md",
  findings: "findings.json",
  test_results: "test_results.json",
  handoff: "handoff.json",
  implementation: "implementation.json",
};

export class WorktreeActions {
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly exclusive: Exclusive,
  ) {}

  async perform(
    action: Extract<
      Action,
      {
        kind:
          | "create_worktree"
          | "remove_worktree"
          | "write_task_files"
          | "merge_base";
      }
    >,
    state: TaskState,
  ): Promise<unknown> {
    const { adapters, store } = this.deps;
    switch (action.kind) {
      case "create_worktree": {
        const repo = this.deps.repoById(action.repoId);
        // Concurrent fetches into one repository fail on its ref locks.
        const created = await this.exclusive(repo.root, async () => {
          const { baseSha } = await adapters.git.fetchBase({
            repoRoot: repo.root,
            baseBranch: action.baseBranch,
          });
          return adapters.git.createWorktree({
            repoRoot: repo.root,
            path: action.path,
            branch: action.branch,
            baseSha,
            requiredCommits: action.requiredCommits,
          });
        });
        // The repo's own setup (dependency install, generated files) runs here, once, so no
        // agent spends a turn discovering an empty node_modules. Idempotent: a retry after a
        // failed setup finds the same worktree and runs it again.
        const setup = (await this.deps.workflow.read(repo.root)).setup;
        if (setup) await this.deps.shell(setup, created.path);
        return created;
      }
      case "remove_worktree": {
        const runs = [...state.runs, ...store.runs(action.taskId)];
        if (
          runs.some(
            (run) =>
              run.worktreePath === action.worktreePath && run.endedAt === null,
          )
        )
          throw new Error("Waiting for live runs to leave the worktree");
        const canonical = async (path: string) =>
          adapters.git.realpath(path).catch(() => resolve(path));
        const root = await canonical(action.worktreePath);
        const panes = await adapters.paneHost.listPanes();
        const livePanePaths = await Promise.all(
          panes
            .filter((pane) => !pane.dead)
            .map((pane) => canonical(pane.startCwd)),
        );
        if (
          livePanePaths.some(
            (path) => path === root || path.startsWith(`${root}${sep}`),
          )
        )
          throw new Error("Waiting for live panes to leave the worktree");
        const repo = this.deps.repoById(action.repoId);
        try {
          return await this.exclusive(repo.root, () =>
            adapters.git.removeWorktree({
              repoRoot: repo.root,
              path: action.worktreePath,
              branch: action.branch,
              allowedRoot: this.deps.config.worktreeRoot,
            }),
          );
        } catch (error) {
          if (error instanceof UnsafeWorktreePathError)
            throw new Fatal(error.message);
          throw error;
        }
      }
      case "write_task_files": {
        const files = action.artifacts.map(({ kind, version }) => {
          const { content } = store.artifact(action.taskId, kind, version);
          return {
            name: FILE_NAMES[kind],
            content:
              typeof content === "string"
                ? content
                : `${JSON.stringify(content, null, 2)}\n`,
          };
        });
        await adapters.git.writeTaskFiles(action.worktreePath, files);
        return {};
      }
      case "merge_base": {
        const worktree = state.worktree;
        if (
          !worktree ||
          worktree.path !== action.worktreePath ||
          worktree.branch !== action.branch ||
          state.task.branch !== action.branch ||
          worktree.baseBranch !== action.baseBranch ||
          action.branch === action.baseBranch ||
          !["ci", "in_review", "awaiting_approval", "merging"].includes(
            state.task.stage,
          ) ||
          state.runs.some((run) => !run.endedAt)
        )
          throw new PreconditionFailed("Base merge owner state changed");
        return this.exclusive(this.deps.repo(action.taskId).root, async () => {
          const observed = await adapters.git.readWorktree(
            action.worktreePath,
            action.baseBranch,
          );
          if (
            !observed.exists ||
            observed.branch !== action.branch ||
            observed.dirty ||
            observed.dirtyPaths.length
          )
            throw new PreconditionFailed("Base merge worktree changed");
          return adapters.git.mergeBase(action);
        });
      }
    }
  }
}
