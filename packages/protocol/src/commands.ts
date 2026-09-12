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

export const command = z.union([
  z.strictObject({
    kind: z.literal("claim_notification"),
    noteId: z.string().min(1).max(300),
  }),
  z.strictObject({ kind: z.literal("open_operator_session") }),
  z.strictObject({ kind: z.literal("stop_operator_session") }),
  z.strictObject({ kind: z.literal("operator_status") }),
  z.strictObject({ kind: z.literal("open_lead_session") }),
  z.strictObject({ kind: z.literal("stop_lead_session") }),
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
    /** Absent means the repo's own defaults. */
    providers: providerRules.nullable(),
    requirePlanApproval: z.boolean().nullable(),
    blockedBy: z.array(taskId),
    budgetMinutes: z.number().int().positive().nullable(),
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
  z.strictObject({
    kind: z.literal("notification"),
    notice: z
      .object({ id: z.string(), title: z.string(), body: z.string() })
      .nullable(),
  }),
  z.strictObject({ kind: z.literal("operator_state"), state: operatorState }),
  z.strictObject({ kind: z.literal("lead_stopped") }),
  /**
   * The command was validated and recorded as an input. It has not run yet: watch the patches and
   * the transition log for what reconcile did with it.
   */
  z.strictObject({ kind: z.literal("human"), inputId }),
  /** The task now exists, in `backlog`. Moving it to `todo` is a separate human command. */
  z.strictObject({ kind: z.literal("task_created"), taskId }),
  z.strictObject({
    kind: z.literal("attach_session"),
    target: z.union([runTarget, leadTarget]),
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
