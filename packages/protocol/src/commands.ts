import {
  pullRequestCommand,
  pullRequestCommitDiff,
  pullRequestDiffRead,
  pullRequestFileContents,
  pullRequestReviewChange,
} from "./pull-requests.js";
// What a window asks the coordinator to do. Human commands become inputs on the task's inbox and
// are acknowledged with the input ID; reconcile decides what happens next and the result arrives
// as patches (principle 3: code moves tasks, and only after validating). UI-only requests answer
// with a value instead.

import { z } from "zod";
import { humanCommand, providerRules } from "./entities.js";
import { inputId, repoId, requestId, runId, sha, taskId } from "./ids.js";
import { operatorState } from "./operator.js";
import { subscription } from "./subscriptions.js";
import {
  leadTarget,
  paneAttachTarget,
  paneIdentity,
  paneView,
  reviewRangeMode,
  reviewState,
  reviewStateChange,
  runTarget,
  taskDiff,
} from "./views.js";

/**
 * Error codes. The first group is the transport's; the second is `McpErrorCode` from
 * `@loom/core`, so a command reconcile rejects carries the same code the MCP tools use.
 */
export const errorCode = z.enum([
  "unauthorized",
  "unsupported_protocol_version",
  "invalid_frame",
  "not_authenticated",
  "already_authenticated",
  "unknown_task",
  "unknown_run",
  "unknown_finding",
  "not_subscribed",
  "sequence_gap",
  "rate_limited",
  "unavailable",
  "internal",
  "invalid_input",
  "stale_run",
  "wrong_stage",
  "guard_failed",
  "conflict",
]);

/** Same shape as `McpError`: a code, a line for the human, and one line per failed guard. */
export const protocolError = z.strictObject({
  code: errorCode,
  message: z.string().min(1),
  details: z.array(z.string()),
});

export const tabName = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(80, "Use at most 80 characters")
  .regex(/^[^\p{Cc}]+$/u, "Names cannot contain control characters");
export const spaceName = tabName.regex(
  /^[^.:]+$/,
  "Space names cannot contain . or :",
);
export const renameSpace = z.strictObject({
  kind: z.literal("rename_space"),
  hostGeneration: z.string().min(1),
  sessionId: z.string().regex(/^\$\d+$/),
  name: spaceName,
});
export const renameTab = z.strictObject({
  kind: z.literal("rename_tab"),
  hostGeneration: z.string().min(1),
  windowId: z.string().regex(/^@\d+$/),
  name: tabName,
});

export const command = z.union([
  renameSpace,
  renameTab,

  ...pullRequestCommand.options,
  pullRequestReviewChange,
  ...pullRequestDiffRead.options,
  z.strictObject({
    kind: z.literal("claim_notification"),
    noteId: z.string().min(1).max(300),
  }),
  z.strictObject({ kind: z.literal("open_operator_session") }),
  z.strictObject({ kind: z.literal("retry_operator_session") }),
  z.strictObject({ kind: z.literal("open_operator_terminal") }),
  z.strictObject({ kind: z.literal("stop_operator_session") }),
  z.strictObject({ kind: z.literal("operator_status") }),
  z.strictObject({ kind: z.literal("open_task_terminal"), taskId }),
  z.strictObject({
    kind: z.literal("open_workbench_terminal"),
    target: paneIdentity.optional(),
    split: z.enum(["right", "below"]).optional(),
    key: z.string().uuid(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("open_pane_session"),
    target: paneIdentity,
  }),
  z.strictObject({
    kind: z.literal("close_terminal"),
    target: paneIdentity,
  }),
  z.strictObject({
    kind: z.literal("create_scratch"),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
    taskId,
    key: z.string().uuid(),
  }),
  z.strictObject({ kind: z.literal("open_lead_session"), repoId }),
  z.strictObject({ kind: z.literal("stop_lead_session"), repoId }),
  z.strictObject({ kind: z.literal("select_repo"), repoId }),
  z.strictObject({
    kind: z.literal("add_repo"),
    root: z.string().min(1),
    github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1).optional(),
  }),
  /** A `HumanCommand` for one task. Validated here, then queued as an input. */
  z.strictObject({ kind: z.literal("human"), taskId, command: humanCommand }),
  /**
   * Create a task. Not a `HumanCommand`: core reconciles a task that already exists, so creation
   * is the coordinator writing a new backlog row, and the ack carries the ID it assigned.
   */
  z.strictObject({
    kind: z.literal("create_task"),
    repoId,
    title: z.string().min(1).max(200),
    description: z.string().max(20000),
    summary: z
      .string()
      .max(140)
      .regex(/^[^\r\n]*$/, "Summary must be one line")
      .nullable(),
    /** Absent means the repo's own defaults. */
    providers: providerRules.nullable(),
    requirePlanApproval: z.boolean().nullable(),
    blockedBy: z.array(taskId),
    budgetMinutes: z.number().int().positive().nullable(),
    size: z.enum(["small", "normal"]).nullable().default(null),
  }),
  /**
   * Where to attach a terminal to this run. Returns the argv and the pane state; it starts no
   * process of its own and never takes a pane over from another client.
   */
  z.strictObject({ kind: z.literal("open_attach_session"), runId }),
  /** The patch for a range. `mode` uses the task's recorded range; explicit SHAs override it. */
  z.strictObject({
    kind: z.literal("fetch_diff"),
    taskId,
    range: z.union([
      z.strictObject({ mode: reviewRangeMode }),
      z.strictObject({ baseSha: sha, headSha: sha }),
    ]),
  }),
  /** Viewed files, the current file and unsent drafts. The coordinator owns them, so they last. */
  z.strictObject({
    kind: z.literal("save_review_state"),
    taskId,
    change: reviewStateChange,
  }),
]);

export type Command = z.output<typeof command>;

export const commandRequest = z.strictObject({
  type: z.literal("command"),
  requestId,
  command,
});

/** What an acknowledged request returns. One arm per request kind, plus `subscribe`. */
export const ackResult = z.union([
  z.strictObject({ kind: z.literal("pull_request_review_state") }),
  z.strictObject({
    kind: z.literal("pull_request_commit"),
    diff: pullRequestCommitDiff,
  }),
  z.strictObject({
    kind: z.literal("pull_request_file"),
    contents: pullRequestFileContents,
  }),
  z.strictObject({ kind: z.literal("renamed") }),
  z.strictObject({
    kind: z.literal("pull_request_action"),
    command: z.enum([
      "pin_pull_request",
      "link_pull_request",
      "comment_pull_request",
      "merge_pull_request",
      "close_pull_request",
      "delete_branch",
      "refresh_pull_requests",
    ]),
    repoId,
    number: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    kind: z.literal("notification"),
    notice: z
      .object({ id: z.string(), title: z.string(), body: z.string() })
      .nullable(),
  }),
  z.strictObject({ kind: z.literal("operator_state"), state: operatorState }),
  z.strictObject({
    kind: z.literal("task_terminal"),
    taskId,
    target: paneIdentity,
    source: z.enum(["agent", "worktree", "project"]),
    branch: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal("scratch_created"), pane: paneView }),
  z.strictObject({ kind: z.literal("terminal_closed"), target: paneIdentity }),
  z.strictObject({ kind: z.literal("lead_stopped") }),
  z.strictObject({ kind: z.literal("repo_selected"), repoId }),
  z.strictObject({ kind: z.literal("repo_added"), repoId }),
  /**
   * The command was validated and recorded as an input. It has not run yet: watch the patches and
   * the transition log for what reconcile did with it.
   */
  z.strictObject({ kind: z.literal("human"), inputId }),
  /** The task now exists, in `backlog`. Moving it to `todo` is a separate human command. */
  z.strictObject({ kind: z.literal("task_created"), taskId }),
  z.strictObject({
    kind: z.literal("attach_session"),
    target: z.union([runTarget, leadTarget, paneAttachTarget]),
  }),
  z.strictObject({ kind: z.literal("diff"), diff: taskDiff }),
  z.strictObject({ kind: z.literal("review_state"), state: reviewState }),
  /** The scope now in force, which may differ from what was asked for. */
  z.strictObject({
    kind: z.literal("subscribed"),
    scope: z.array(subscription),
  }),
]);

export type AckResult = z.output<typeof ackResult>;

/** Exactly one request gets exactly one of these: the result, or the reason it was refused. */
export const ackOutcome = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: ackResult }),
  z.strictObject({ ok: z.literal(false), error: protocolError }),
]);

export const ack = z.strictObject({
  type: z.literal("ack"),
  requestId,
  outcome: ackOutcome,
});

export type Ack = z.output<typeof ack>;
export type AckOutcome = z.output<typeof ackOutcome>;
export type ProtocolError = z.output<typeof protocolError>;
export type ErrorCode = z.output<typeof errorCode>;
