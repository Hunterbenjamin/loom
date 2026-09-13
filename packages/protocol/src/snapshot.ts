import {
  pullRequestDetailRow,
  pullRequestKey,
  pullRequestListKey,
  pullRequestListState,
  pullRequestRow,
} from "./pull-requests.js";
// The entity registry, and the snapshot built out of it. A client's state has exactly this shape:
// a full snapshot on connect, then patches that upsert and delete rows of the same collections.

import type {
  Approval,
  Finding,
  Question,
  Repo,
  Run,
  Task,
  Transition,
  Worktree,
} from "@loom/core";
import { z } from "zod";
import {
  approval,
  finding,
  question,
  repo,
  run,
  task,
  transition,
  worktree,
} from "./entities.js";
import {
  approvalId,
  findingId,
  isoTime,
  messageId,
  questionId,
  repoId,
  runId,
  seq,
  taskId,
  threadId,
  transitionId,
  worktreePath,
} from "./ids.js";
import { taskNote } from "./notes.js";
import {
  commentThread,
  leadState,
  paneInventoryState,
  paneView,
  reviewState,
  runTarget,
  taskChanges,
  taskInbox,
  taskMessage,
  taskPlan,
  taskTestResults,
} from "./views.js";

/**
 * Every collection a client holds, with its key schema and the key of a value. `task` is
 * task-list level and reaches every client; the rest follow subscriptions.
 */
export const projectState = z.strictObject({
  id: z.literal("project"),
  repoId: repoId.nullable(),
});

export const collections = {
  project: {
    value: projectState,
    key: z.literal("project"),
    keyOf: (v: z.output<typeof projectState>) => v.id,
  },
  pull_requests: {
    value: pullRequestListState,
    key: z.string().min(1),
    keyOf: (v: z.output<typeof pullRequestListState>) =>
      pullRequestListKey(v.repoId, v.state),
  },
  pull_request: {
    value: pullRequestRow,
    key: z.string().min(1),
    keyOf: (v: z.output<typeof pullRequestRow>) =>
      pullRequestKey(v.repoId, v.number),
  },
  pull_request_detail: {
    value: pullRequestDetailRow,
    key: z.string().min(1),
    keyOf: (v: z.output<typeof pullRequestDetailRow>) =>
      pullRequestKey(v.repoId, v.number),
  },
  note: {
    value: taskNote,
    key: z.string(),
    keyOf: (v: z.output<typeof taskNote>) => v.id,
  },
  pane_inventory: {
    value: paneInventoryState,
    key: z.literal("panes"),
    keyOf: (v: z.output<typeof paneInventoryState>) => v.id,
  },
  pane: {
    value: paneView,
    key: z.string().min(1),
    keyOf: (v: z.output<typeof paneView>) => v.id,
  },
  lead: {
    value: leadState,
    key: repoId,
    keyOf: (v: z.output<typeof leadState>) => v.id,
  },
  inbox: {
    value: taskInbox,
    key: taskId,
    keyOf: (v: z.output<typeof taskInbox>) => v.taskId,
  },
  repo: { value: repo, key: repoId, keyOf: (v: Repo) => v.id },
  task: { value: task, key: taskId, keyOf: (v: Task) => v.id },
  worktree: {
    value: worktree,
    key: worktreePath,
    keyOf: (v: Worktree) => v.path,
  },
  run: { value: run, key: runId, keyOf: (v: Run) => v.id },
  run_target: {
    value: runTarget,
    key: runId,
    keyOf: (v: z.output<typeof runTarget>) => v.runId,
  },
  message: {
    value: taskMessage,
    key: messageId,
    keyOf: (v: z.output<typeof taskMessage>) => v.id,
  },
  question: { value: question, key: questionId, keyOf: (v: Question) => v.id },
  finding: { value: finding, key: findingId, keyOf: (v: Finding) => v.id },
  approval: { value: approval, key: approvalId, keyOf: (v: Approval) => v.id },
  plan: {
    value: taskPlan,
    key: taskId,
    keyOf: (v: z.output<typeof taskPlan>) => v.taskId,
  },
  test_results: {
    value: taskTestResults,
    key: taskId,
    keyOf: (v: z.output<typeof taskTestResults>) => v.taskId,
  },
  transition: {
    value: transition,
    key: transitionId,
    keyOf: (v: Transition) => v.id,
  },
  thread: {
    value: commentThread,
    key: threadId,
    keyOf: (v: z.output<typeof commentThread>) => v.id,
  },
  review_state: {
    value: reviewState,
    key: taskId,
    keyOf: (v: z.output<typeof reviewState>) => v.taskId,
  },
  changes: {
    value: taskChanges,
    key: z.string().min(1),
    keyOf: (v: z.output<typeof taskChanges>) => v.id,
  },
} as const;

export type CollectionName = keyof typeof collections;
export type Entities = {
  [N in CollectionName]: z.output<(typeof collections)[N]["value"]>;
};

export const COLLECTION_NAMES = Object.keys(collections) as CollectionName[];

/** The key a collection stores a value under. Deletes name the same key. */
export function keyOf<N extends CollectionName>(
  name: N,
  value: Entities[N],
): string {
  const collection = collections[name] as {
    keyOf: (v: Entities[N]) => string;
  };
  return collection.keyOf(value);
}

export const snapshotBody = z.strictObject({
  projects: z.array(projectState).default([]),
  pullRequestLists: z.array(pullRequestListState).default([]),
  pullRequests: z.array(pullRequestRow).default([]),
  pullRequestDetails: z.array(pullRequestDetailRow).default([]),
  notes: z.array(taskNote).default([]),
  paneInventory: z.array(paneInventoryState).default([]),
  panes: z.array(paneView).default([]),
  leads: z.array(leadState).default([]),
  inbox: z.array(taskInbox),
  repos: z.array(repo),
  tasks: z.array(task),
  worktrees: z.array(worktree),
  runs: z.array(run),
  runTargets: z.array(runTarget),
  messages: z.array(taskMessage),
  questions: z.array(question),
  findings: z.array(finding),
  approvals: z.array(approval),
  plans: z.array(taskPlan),
  testResults: z.array(taskTestResults),
  transitions: z.array(transition),
  threads: z.array(commentThread),
  reviewStates: z.array(reviewState),
  changes: z.array(taskChanges),
});

/** Which snapshot collection each patch collection lands in. */
export const COLLECTION_FIELDS = {
  project: "projects",
  pull_requests: "pullRequestLists",
  pull_request: "pullRequests",
  pull_request_detail: "pullRequestDetails",
  note: "notes",
  pane_inventory: "paneInventory",
  pane: "panes",
  lead: "leads",
  inbox: "inbox",
  repo: "repos",
  task: "tasks",
  worktree: "worktrees",
  run: "runs",
  run_target: "runTargets",
  message: "messages",
  question: "questions",
  finding: "findings",
  approval: "approvals",
  plan: "plans",
  test_results: "testResults",
  transition: "transitions",
  thread: "threads",
  review_state: "reviewStates",
  changes: "changes",
} as const satisfies Record<CollectionName, keyof SnapshotBody>;

export type SnapshotBody = z.output<typeof snapshotBody>;

export const emptySnapshotBody = (): SnapshotBody => ({
  projects: [],
  pullRequestLists: [],
  pullRequests: [],
  pullRequestDetails: [],
  notes: [],
  paneInventory: [],
  panes: [],
  leads: [],
  inbox: [],
  repos: [],
  tasks: [],
  worktrees: [],
  runs: [],
  runTargets: [],
  messages: [],
  questions: [],
  findings: [],
  approvals: [],
  plans: [],
  testResults: [],
  transitions: [],
  threads: [],
  reviewStates: [],
  changes: [],
});

export const snapshotMeta = z.strictObject({
  /** The sequence the patch stream continues from: the next patch is `seq + 1`. */
  seq,
  now: isoTime,
  /** The coordinator run this stream belongs to; a change means every client resubscribes. */
  epoch: z.string().min(1),
});

export type SnapshotMeta = z.output<typeof snapshotMeta>;
