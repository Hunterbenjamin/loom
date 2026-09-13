// Views the coordinator derives for its windows. Everything here is coordinator-owned and
// survives a window closing (architecture principle 5); the store persists it, the UI only
// renders it. Each one answers a gap the fixture shell found (PR #18, gaps 3-6).

import { z } from "zod";
import {
  attentionReason,
  message as messageSchema,
  plan as planSchema,
  run,
  testResult,
} from "./entities.js";
import {
  count,
  draftId,
  fileId,
  findingId,
  isoTime,
  path,
  providerSessionId,
  repoId,
  runId,
  sha,
  taskId,
  text,
  threadId,
  worktreePath,
} from "./ids.js";

/**
 * `Message` and `TestResult` carry only a run ID, and the task ID is not safely recoverable from
 * it, so the protocol adds the key the UI joins on (gap 7). No consumer parses a run ID.
 */
export const taskMessage = messageSchema.extend({ taskId });

/** The latest plan for a task, with the version an approval names. */
export const taskPlan = z.strictObject({
  taskId,
  version: count,
  accepted: z.boolean(),
  plan: planSchema,
});

/** A task's test results, as the `test_results` artifact records them. Keyed by task. */
export const taskTestResults = z.strictObject({
  taskId,
  results: z.array(testResult),
  updatedAt: isoTime,
});

// ---------------------------------------------------------------- attach and pane host

/**
 * What a terminal client runs to attach to a run. argv, never a shell string, and never a
 * takeover: the pane host allows many clients at once (docs/design/ui.md).
 */
export const attachTarget = z.strictObject({
  /** `pane_host` for an interactive run's pane; `provider` for `codex resume --remote`. */
  kind: z.enum(["pane_host", "provider"]),
  argv: z.array(z.string().min(1)).min(1),
  cwd: worktreePath,
  /** The allowlisted environment the pane was started with, for a client that starts its own. */
  env: z.record(z.string().min(1), z.string()),
});

/** The pane host's own reading of a run's pane. A hint for the UI, never a source of run status. */
export const paneState = z.strictObject({
  /**
   * Pane IDs restart at `%0` after the host dies, so a reference is only valid in its generation.
   * The same string `PaneRef.hostGeneration` carries (`loom-<instance>#<server pid>`).
   */
  hostGeneration: z.string().min(1),
  sessionName: z.string().min(1),
  windowId: z.string().min(1).nullable(),
  paneId: z.string().min(1),
  /** The pane's process exited. `exitStatus` is null when the host didn't report one. */
  dead: z.boolean(),
  exitStatus: z.number().int().nullable(),
  /** How many clients are attached right now; 0 is normal and means nothing about the agent. */
  attachedClients: count,
  size: z.strictObject({ cols: count, rows: count }).nullable(),
  observedAt: isoTime,
});

/** Per run: where a human attaches, and what the pane host says about it. */
export const runTarget = z.strictObject({
  runId,
  taskId,
  sessionId: providerSessionId.nullable(),
  /** Null for a headless run with no pane, or before the pane exists. */
  attach: attachTarget.nullable(),
  pane: paneState.nullable(),
});

// ---------------------------------------------------------------- the reviewed range

export const reviewRangeMode = z.enum(["whole_branch", "since_last_review"]);

/**
 * Which diff is under review (gap 6). `whole_branch` runs from the merge base; the other runs
 * from the head the last review round saw, which is what a fix round wants to look at.
 */
export const reviewRange = z
  .strictObject({
    mode: reviewRangeMode,
    baseSha: sha,
    headSha: sha,
    /** The head the last reviewer submitted against; null before the first round. */
    lastReviewedHead: sha.nullable(),
  })
  .refine(
    (v) =>
      v.mode === "whole_branch" ||
      (v.lastReviewedHead !== null && v.baseSha === v.lastReviewedHead),
    "since_last_review must start at lastReviewedHead",
  );

// ---------------------------------------------------------------- changed files

export const fileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
]);

/**
 * One changed file, from Git metadata and never from patch text (spike 04). `version` is
 * monotonic per `id`: Pierre ignores a changed file whose version didn't change, so it is bumped
 * whenever the content or the annotations on it change.
 */
export const changedFile = z.strictObject({
  /** Stable while this is the same file, across heads and renames. Pierre's file key. */
  id: fileId,
  path,
  previousPath: path.nullable(),
  status: fileStatus,
  binary: z.boolean(),
  /** Null for a binary file: there are no lines to count. */
  added: count.nullable(),
  deleted: count.nullable(),
  version: count,
});

const changesKeyOf = (task: string, mode: string): string => `${task}#${mode}`;

/** The changed-files model for one task and one range (gap 5). Keyed by task and mode. */
export const taskChanges = z
  .strictObject({
    /** `<taskId>#<mode>`: two windows can review the same task through different ranges. */
    id: z.string().min(1),
    taskId,
    range: reviewRange,
    files: z.array(changedFile),
    /** Content key for the patch these files came from; a client caches against it. */
    patchKey: z.string().min(1),
    computedAt: isoTime,
  })
  .refine(
    (v) => v.id === changesKeyOf(v.taskId, v.range.mode),
    "id must be `<taskId>#<mode>`",
  );

export const changesKey = (
  task: z.output<typeof taskId>,
  mode: z.output<typeof reviewRangeMode>,
): string => changesKeyOf(task, mode);

/** The patch itself, fetched on demand rather than pushed: it is far larger than its metadata. */
export const taskDiff = z.strictObject({
  taskId,
  range: reviewRange,
  /** A Git patch, exactly as `git diff` prints it. Empty input is an error, not a clean diff. */
  patch: z.strictObject({ text, key: z.string().min(1) }),
  files: z.array(changedFile),
  computedAt: isoTime,
});

// ---------------------------------------------------------------- review conversation

export const commentAuthor = z.union([
  z.strictObject({ kind: z.literal("human"), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("agent"), runId }),
  z.strictObject({ kind: z.literal("system") }),
]);

export const comment = z.strictObject({
  id: z.string().min(1),
  author: commentAuthor,
  body: text,
  at: isoTime,
  editedAt: isoTime.nullable(),
  /** The GitHub review comment this came from or was mirrored to. */
  externalId: z.string().min(1).nullable(),
});

/** Review is a conversation, and it has to survive a restart (gap 3). One thread per finding. */
export const commentThread = z.strictObject({
  id: threadId,
  taskId,
  findingId,
  comments: z.array(comment),
  resolvedAt: isoTime.nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
});

/** A file the human has marked read, at the head they read it at. */
export const viewedFile = z.strictObject({
  fileId,
  path,
  headSha: sha,
  at: isoTime,
});

/** An unsent reply. Kept by the coordinator so closing the window doesn't lose it (gap 4). */
export const draft = z.strictObject({
  id: draftId,
  /** The thread being replied to, or null for the first comment on `findingId`. */
  threadId: threadId.nullable(),
  findingId: findingId.nullable(),
  /** For a comment being written against a file rather than a finding. */
  fileId: fileId.nullable(),
  body: text,
  updatedAt: isoTime,
});

/** The review shell's state for one task: what has been read, where the human is, what is unsent. */
export const reviewState = z.strictObject({
  taskId,
  /** The head this state was recorded against; viewed files at an older head are stale, not lost. */
  headSha: sha,
  mode: reviewRangeMode,
  viewedFiles: z.array(viewedFile),
  currentFile: fileId.nullable(),
  drafts: z.array(draft),
  updatedAt: isoTime,
});

/** What a window may change about the review shell. Everything absent is left alone. */
export const reviewStateChange = z.strictObject({
  headSha: sha,
  mode: reviewRangeMode.optional(),
  viewed: z.array(viewedFile).optional(),
  unviewed: z.array(fileId).optional(),
  currentFile: fileId.nullable().optional(),
  drafts: z.array(draft).optional(),
  deleteDrafts: z.array(draftId).optional(),
});

export type TaskMessage = z.output<typeof taskMessage>;
export type TaskPlan = z.output<typeof taskPlan>;
export type TaskTestResults = z.output<typeof taskTestResults>;
export type AttachTarget = z.output<typeof attachTarget>;
export type PaneState = z.output<typeof paneState>;
export type RunTarget = z.output<typeof runTarget>;
export type ReviewRangeMode = z.output<typeof reviewRangeMode>;
export type ReviewRange = z.output<typeof reviewRange>;
export type ChangedFile = z.output<typeof changedFile>;
export type TaskChanges = z.output<typeof taskChanges>;
export type TaskDiff = z.output<typeof taskDiff>;
export type Comment = z.output<typeof comment>;
export type CommentThread = z.output<typeof commentThread>;
export type ViewedFile = z.output<typeof viewedFile>;
export type Draft = z.output<typeof draft>;
export type ReviewState = z.output<typeof reviewState>;
export type ReviewStateChange = z.output<typeof reviewStateChange>;

/** Small task-list metadata for the inbox; no detail subscriptions or Git reads required. */
export const taskInbox = z.strictObject({
  forHuman: z
    .object({ occurrence: z.string(), summary: z.string(), noteId: z.string() })
    .nullable()
    .optional(),
  taskId,
  reasonRuns: z.partialRecord(attentionReason, z.array(run)),
  reviewedHead: sha.nullable(),
  planVersion: count.nullable(),
});
export type TaskInbox = z.output<typeof taskInbox>;

// Instance-level Lead identity; it is not a task or run.
export const leadTarget = runTarget
  .omit({ runId: true, taskId: true })
  .extend({ identity: z.literal("lead"), repoId });
export type LeadTarget = z.output<typeof leadTarget>;
export const leadState = z.strictObject({
  id: repoId,
  sessionId: providerSessionId.nullable(),
  status: z.enum(["working", "idle", "waiting", "unknown", "stopped"]),
});
export type LeadState = z.output<typeof leadState>;

/** Physical identity is generation + pane ID; names never identify a provider run. */
export const paneIdentity = z.strictObject({
  hostGeneration: z.string().min(1),
  sessionName: z.string().min(1),
  windowId: z.string().regex(/^@\d+$/),
  paneId: z.string().regex(/^%\d+$/),
});
export type PaneIdentity = z.output<typeof paneIdentity>;
export const paneView = paneIdentity
  .extend({
    id: z.string().min(1),
    sessionId: z.string().nullable(),
    windowName: z.string().nullable(),
    title: z.string().nullable(),
    command: z.string(),
    startCwd: worktreePath,
    branch: z.string().min(1).nullable(),
    dead: z.boolean(),
    exitStatus: z.number().int().nullable(),
    /** Session-group attachments, not viewers focused on this pane. */
    attachedClients: count,
    unavailable: z.boolean(),
    taskId: taskId.nullable(),
    runId: runId.nullable(),
    taskLabel: z.string().nullable(),
    role: z.string().nullable(),
    provider: z.string().nullable(),
    status: z.string().nullable(),
    attention: z.boolean(),
  })
  .refine(
    (v) => v.id === JSON.stringify([v.hostGeneration, v.paneId]),
    "Invalid pane key",
  );
export type PaneView = z.output<typeof paneView>;
export const paneAttachTarget = z.strictObject({
  identity: z.literal("pane"),
  target: paneIdentity,
  attach: attachTarget,
  pane: paneState,
});
export type PaneAttachTarget = z.output<typeof paneAttachTarget>;

export const paneInventoryState = z.strictObject({
  id: z.literal("panes"),
  unavailable: z.boolean(),
});
