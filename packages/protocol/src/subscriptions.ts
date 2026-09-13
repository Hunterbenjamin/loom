import {
  pullRequestKey,
  pullRequestNumber,
  pullRequestState,
} from "./pull-requests.js";
// What a client is showing, so the coordinator sends it only that. Task-list-level changes reach
// every client; the expensive collections (runs, findings, transitions, diffs) follow a
// subscription. Both sides use the functions here, so a window and the coordinator can't disagree
// about what "in scope" means.

import type { Task } from "@loom/core";
import { z } from "zod";
import { repoId, runId, taskId } from "./ids.js";
import type { Change } from "./patch.js";
import type { CollectionName } from "./snapshot.js";
import { reviewRangeMode } from "./views.js";

export const viewName = z.enum([
  "all",
  "needs_you",
  "in_progress",
  "awaiting_approval",
  "done",
]);
export type ViewName = z.output<typeof viewName>;

export const subscription = z.union([
  z.strictObject({
    kind: z.literal("pull_requests"),
    repoId,
    state: pullRequestState.default("open"),
  }),
  z.strictObject({
    kind: z.literal("pull_request"),
    repoId,
    number: pullRequestNumber,
  }),
  z.strictObject({ kind: z.literal("panes") }),
  /** Workbench status list, including agents without terminal panes. */
  z.strictObject({ kind: z.literal("agents") }),
  /** A task list: the client receives the tasks these views match, and nothing else changes. */
  z.strictObject({
    kind: z.literal("views"),
    views: z.array(viewName).min(1),
    /** Null means every repo. */
    repoIds: z.array(repoId).min(1).nullable(),
  }),
  /** One task's detail: runs, messages, questions, findings, approvals, plan, tests, threads. */
  z.strictObject({ kind: z.literal("task"), taskId }),
  /** One task's changed files for one range. The patch text itself is fetched, not pushed. */
  z.strictObject({
    kind: z.literal("diff"),
    taskId,
    mode: reviewRangeMode,
  }),
  /** One run's attach target and pane state, for a terminal panel. */
  z.strictObject({ kind: z.literal("run"), runId }),
]);

export type Subscription = z.output<typeof subscription>;

const IN_PROGRESS = ["planning", "in_progress", "in_review", "merging"];

/** The one definition of each view. The shell's sidebar and the coordinator both use it. */
export function taskInView(task: Task, view: ViewName): boolean {
  switch (view) {
    case "all":
      return true;
    case "needs_you":
      return (
        task.attention.reasons.length > 0 ||
        task.blocked !== null ||
        task.failed !== null
      );
    case "in_progress":
      return IN_PROGRESS.includes(task.stage);
    case "awaiting_approval":
      return (
        task.stage === "plan_approval" || task.stage === "awaiting_approval"
      );
    case "done":
      return task.stage === "done" || task.stage === "canceled";
  }
}

/** Collections that reach every client, whatever it subscribed to. */
const ALWAYS: CollectionName[] = [
  "repo",
  "inbox",
  "lead",
  "operator",
  "project",
];

export interface Scope {
  pullRequestRepos: Set<string>;
  pullRequestDetails: Set<string>;
  panes: boolean;
  agents: boolean;
  views: { views: ViewName[]; repoIds: Set<string> | null }[];
  tasks: Set<string>;
  diffs: Set<string>;
  runs: Set<string>;
}

export function scopeOf(subscriptions: readonly Subscription[]): Scope {
  const scope: Scope = {
    pullRequestRepos: new Set(),
    pullRequestDetails: new Set(),
    panes: false,
    agents: false,
    views: [],
    tasks: new Set(),
    diffs: new Set(),
    runs: new Set(),
  };
  for (const s of subscriptions) {
    if (s.kind === "pull_requests") scope.pullRequestRepos.add(s.repoId);
    else if (s.kind === "pull_request")
      scope.pullRequestDetails.add(pullRequestKey(s.repoId, s.number));
    else if (s.kind === "views")
      scope.views.push({
        views: s.views,
        repoIds: s.repoIds ? new Set<string>(s.repoIds) : null,
      });
    else if (s.kind === "task") scope.tasks.add(s.taskId);
    else if (s.kind === "diff") scope.diffs.add(`${s.taskId}#${s.mode}`);
    else if (s.kind === "panes") scope.panes = true;
    else if (s.kind === "agents") scope.agents = true;
    else scope.runs.add(s.runId);
  }
  return scope;
}

/**
 * Is this task in the client's task list? A client with no view subscription gets every task, so a
 * CLI can connect and see everything without knowing the view names.
 */
export function taskInScope(scope: Scope, task: Task): boolean {
  if (scope.agents || scope.views.length === 0) return true;
  return scope.views.some(
    (v) =>
      (v.repoIds === null || v.repoIds.has(task.repoId)) &&
      v.views.some((view) => taskInView(task, view)),
  );
}

/** The task a change belongs to, or null when it isn't task-scoped. */
export function ownerTask(change: Change): string | null {
  if (change.op === "delete") return change.taskId;
  if (
    change.collection === "pull_request" ||
    change.collection === "pull_request_detail" ||
    change.collection === "repo" ||
    change.collection === "project" ||
    change.collection === "lead" ||
    change.collection === "operator" ||
    change.collection === "pane_inventory"
  )
    return null;
  if (change.collection === "task") return change.value.id;
  return change.value.taskId;
}

/** Does this change belong on this client's stream? */
export function inScope(scope: Scope, change: Change): boolean {
  if (
    change.collection === "pull_request" ||
    change.collection === "pull_request_detail"
  ) {
    const key =
      change.op === "delete"
        ? change.key
        : pullRequestKey(change.value.repoId, change.value.number);
    if (change.collection === "pull_request_detail")
      return scope.pullRequestDetails.has(key);
    // State is a polling filter. Subscribers receive all cached states for their repo,
    // including state changes that remove a row from the visible filter.
    return [...scope.pullRequestRepos].some((repo) =>
      key.startsWith(`${JSON.stringify([repo]).slice(0, -1)},`),
    );
  }
  if (change.collection === "pane" || change.collection === "pane_inventory")
    return scope.panes;
  if (ALWAYS.includes(change.collection)) return true;
  if (
    scope.agents &&
    (change.collection === "run" || change.collection === "question")
  )
    return true;
  if (change.collection === "task") {
    if (change.op === "delete") return true;
    return taskInScope(scope, change.value) || scope.tasks.has(change.value.id);
  }
  if (change.collection === "changes")
    return scope.diffs.has(
      change.op === "delete" ? change.key : change.value.id,
    );
  if (change.collection === "run") {
    const id = change.op === "delete" ? change.key : change.value.id;
    if (scope.runs.has(id)) return true;
  }
  if (change.collection === "run_target") {
    const id = change.op === "delete" ? change.key : change.value.runId;
    if (scope.runs.has(id)) return true;
  }
  const owner = ownerTask(change);
  return owner !== null && scope.tasks.has(owner);
}

/** The changes of a patch this client should see, in order. */
export function filterChanges(
  scope: Scope,
  changes: readonly Change[],
): Change[] {
  return changes.filter((c) => inScope(scope, c));
}
