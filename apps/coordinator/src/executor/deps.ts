import type { InputId, Repo, RepoId, TaskId } from "@loom/core";
import type { Store } from "@loom/store";
import type { Adapters, ReportAdapterFailure } from "../adapters.js";
import type { CoordinatorConfig } from "../config.js";
import type { LaunchDeps } from "../launch.js";
import type { PullRequestCache } from "../observe.js";
import type { Shell } from "../shell.js";
import type { WorkflowReader } from "../workflow.js";

export interface ExecutorDeps {
  store: Store;
  adapters: Adapters;
  config: CoordinatorConfig;
  launch: LaunchDeps;
  pullRequests: PullRequestCache;
  workflow: WorkflowReader;
  /** Runs the repository's WORKFLOW `setup` command once the worktree exists. */
  shell: Shell;
  repo(taskId: TaskId): Repo;
  repoById(repoId: RepoId): Repo;
  repositorySettings(repoId: RepoId): {
    baseBranch: string;
  };
  /** Enqueue `reconcile(taskId)` at a time, for a `schedule` action. */
  schedule(taskId: TaskId, at: string, why: string): void;
  notify(level: "info" | "attention", title: string, body: string): void;
  now(): string;
  nextInputId(): InputId;
  /** Called after each recorded result, so the loop picks the input up. */
  onResult(taskId: TaskId): void;
  /**
   * Whether this task's actions may run now: its latest commit rests on fresh readings. A task
   * that may not is handed to `onUnconfirmed`, which asks for the pass that confirms it.
   */
  mayAct(taskId: TaskId): boolean;
  onUnconfirmed(taskId: TaskId): void;
  reportAdapterFailure?: ReportAdapterFailure;
}

/** The executor owns lock lifetime; handlers name the existing git critical section. */
export type Exclusive = <T>(key: string, work: () => Promise<T>) => Promise<T>;
