import type { Action, ActionResult, TaskId } from "@loom/core";
import type { PullRequestCommand } from "@loom/protocol";
import type { ExecutorDeps } from "./executor/deps.js";
import { classify, Fatal } from "./executor/errors.js";
import { GitHubActions } from "./executor/github.js";
import { RunActions } from "./executor/runs.js";
import { WorktreeActions } from "./executor/worktrees.js";

export type { ExecutorDeps } from "./executor/deps.js";
export { classify, Fatal, PreconditionFailed } from "./executor/errors.js";
export { pressPaneChoice } from "./executor/runs.js";

// The executor (brief §2). It claims outbox rows, rechecks the claim immediately before any side
// effect, maps every `Action` kind to the adapter that owns it, and records the outcome with
// `store.outbox.finish` as an `action_result` input for the next pass.
//
// Actions run at least once (design §5.4), so every executor checks the owner first: an existing
// worktree, an existing PR, a live session under that ID, a remote head already at the SHA.

export class Executor {
  private draining: Promise<number> | null = null;
  /** Wakes a drain that is waiting on running actions, to look for newly claimable rows. */
  private wake: (() => void) | null = null;
  private again = false;
  /** One action at a time per task; different tasks' actions run concurrently. */
  private readonly running = new Map<TaskId, Promise<void>>();
  /** Git operations that write a repository's shared refs or worktree list, per repository. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  private readonly worktrees: WorktreeActions;
  private readonly runs: RunActions;
  private readonly github: GitHubActions;

  constructor(private readonly deps: ExecutorDeps) {
    const exclusive = this.exclusive.bind(this);
    this.worktrees = new WorktreeActions(deps, exclusive);
    this.runs = new RunActions(deps);
    this.github = new GitHubActions(deps, exclusive);
  }

  /** Repository actions have no task/outbox identity; execute once and re-read before retry. */
  async pullRequest(command: PullRequestCommand): Promise<void> {
    return this.github.pullRequest(command);
  }

  /**
   * Runs every claimable row until none is left, one per task at a time and tasks concurrently,
   * and answers how many ran. Safe to call concurrently: a call during a drain joins it, and the
   * drain looks for claimable rows again before it finishes.
   */
  drain(): Promise<number> {
    if (this.draining) {
      this.again = true;
      this.wake?.();
      return this.draining;
    }
    const work = this.loop().finally(() => {
      this.draining = null;
    });
    this.draining = work;
    return work;
  }

  private async loop(): Promise<number> {
    let done = 0;
    for (;;) {
      this.again = false;
      const unconfirmed = new Set<TaskId>();
      for (;;) {
        const claim = this.deps.store.outbox.claim(
          this.deps.now() as never,
          undefined,
          (taskId) => {
            if (this.running.has(taskId)) return false;
            if (this.deps.mayAct(taskId)) return true;
            unconfirmed.add(taskId);
            return false;
          },
        );
        if (!claim) break;
        const { taskId } = claim;
        this.running.set(
          taskId,
          this.execute(claim.key, claim.claimVersion, claim.action).finally(
            () => {
              this.running.delete(taskId);
              done++;
            },
          ),
        );
      }
      for (const taskId of unconfirmed) this.deps.onUnconfirmed(taskId);
      if (!this.running.size && !this.again) return done;
      if (this.running.size && !this.again)
        await Promise.race([
          ...this.running.values(),
          new Promise<void>((resolve) => {
            this.wake = resolve;
          }),
        ]);
      this.wake = null;
    }
  }

  async refreshBase(
    repoRoot: import("@loom/core").WorktreePath,
    baseBranch: string,
  ): Promise<void> {
    await this.exclusive(repoRoot, () =>
      this.deps.adapters.git.fetchBase({ repoRoot, baseBranch }),
    );
  }

  /** Runs `work` after every earlier holder of `key` has finished. */
  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.repoLocks.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.repoLocks.set(key, settled);
    void settled.then(() => {
      if (this.repoLocks.get(key) === settled) this.repoLocks.delete(key);
    });
    return result;
  }

  private async execute(
    key: Action["key"],
    claimVersion: number,
    action: Action | undefined,
  ): Promise<void> {
    const { store } = this.deps;
    if (!action) {
      // A receipt row with no payload cannot be routed; leaving it claimed would stall the task.
      store.outbox.requeue(key, claimVersion);
      return;
    }
    let result: ActionResult;
    try {
      // Cancellation can race an action that is already claimed; never act on a superseded row.
      if (!store.outbox.isClaimCurrent(key, claimVersion)) return;
      const output = await this.perform(action);
      result = { kind: action.kind, ok: true, output } as ActionResult;
    } catch (error) {
      result = {
        kind: action.kind,
        ok: false,
        error: classify(error),
      } as ActionResult;
    }
    store.outbox.finish(key, claimVersion, {
      id: this.deps.nextInputId(),
      receivedAt: this.deps.now() as never,
      type: "action_result",
      key,
      result,
    });
    this.deps.onResult(action.taskId);
  }

  /** One action against its owner. Throws PreconditionFailed or Fatal to classify a failure. */
  private async perform(action: Action): Promise<unknown> {
    const state = this.deps.store.loadTaskState(action.taskId);
    switch (action.kind) {
      case "create_worktree":
      case "remove_worktree":
      case "write_task_files":
      case "merge_base":
        return this.worktrees.perform(action, state);
      case "open_workspace":
      case "start_run":
      case "send_message":
      case "interrupt_run":
      case "answer_pane_prompt":
      case "answer_provider_request":
      case "stop_run":
        return this.runs.perform(action, state);
      case "push_branch":
      case "open_pr":
      case "update_pr_body":
      case "merge_pr":
      case "disable_auto_merge":
      case "map_findings":
      case "refresh":
        return this.github.perform(action, state);
      case "schedule":
        this.deps.schedule(action.taskId, action.at, action.why);
        return {};
      case "notify":
        this.deps.notify(action.level, action.title, action.body);
        return {};
      default: {
        // Handle unknown action kinds that may exist in the database but not in this executor version
        const unknownAction = action as unknown as {
          kind: string;
          key: string;
        };
        throw new Fatal(
          `Unknown action kind '${unknownAction.kind}' (key: ${unknownAction.key}). ` +
            `This may indicate a schema drift between core and store. ` +
            `Ensure the action kind is added to both packages/core/src/actions.ts ActionOutputs ` +
            `and packages/store/src/action-schemas.ts.`,
        );
      }
    }
  }
}
