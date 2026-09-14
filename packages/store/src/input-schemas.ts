import type { Input, InputDisposition } from "@loom/core";
import { z } from "zod";
import { actionResultSchema } from "./action-schemas.js";
import { anchorSchema, planSchema } from "./entity-schemas.js";
import {
  contract,
  count,
  findingStatus,
  id,
  positive,
  severity,
  sha,
  side,
  text,
  time,
} from "./schema-helpers.js";

const testResult = z.object({
  command: text,
  outcome: z.enum(["passed", "failed", "skipped", "errored"]),
  summary: text,
});
const callSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("submit_plan"),
    input: z.object({ plan: planSchema }),
  }),
  z.object({
    tool: z.literal("report_progress"),
    input: z.object({
      summary: text,
      stepIndex: count.nullable(),
      decisions: z.array(text),
      testResults: z.array(testResult),
    }),
  }),
  z.object({
    tool: z.literal("ask_human"),
    input: z.object({
      question: text,
      options: z.array(text),
      blocking: z.boolean(),
    }),
    questionId: id,
  }),
  z.object({
    tool: z.literal("submit_for_review"),
    input: z.object({
      headSha: sha,
      summary: text,
      testResults: z.array(testResult),
      handoff: z.object({ summary: text, nextSteps: z.array(text) }),
    }),
  }),
  z.object({
    tool: z.literal("submit_review"),
    input: z.object({
      reviewedSha: sha,
      reviewerCommits: z.array(sha).default([]),
      summary: text,
      findings: z.array(
        z.object({
          severity,
          title: text,
          body: text,
          status: z.enum(["open", "fixed", "escalate"]).optional(),
          commitSha: sha.optional(),
          reason: text.optional(),
          location: z
            .object({
              path: text,
              side,
              startLine: positive,
              endLine: positive,
            })
            .nullable(),
        }),
      ),
      verdicts: z.array(
        z.object({
          findingId: id,
          status: z.enum(["resolved", "reopened", "fixed", "escalate"]),
          commitSha: sha.optional(),
          reason: text.optional(),
          note: text,
        }),
      ),
      testResults: z.array(testResult),
    }),
    drafts: z.array(z.object({ id, anchor: anchorSchema.nullable() })),
  }),
  z.object({
    tool: z.literal("resolve_finding"),
    input: z.object({
      findingId: id,
      resolution: z.enum(["fixed", "disputed"]),
      note: text,
      commitSha: sha.nullable(),
    }),
  }),
]);
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("push_branch"), headSha: sha }),
  z.object({ type: z.literal("open_pr"), headSha: sha }),
  z.object({ type: z.literal("move"), to: z.enum(["backlog", "todo"]) }),
  z.object({ type: z.literal("approve_plan"), planVersion: positive }),
  z.object({ type: z.literal("reject_plan"), feedback: text }),
  z.object({ type: z.literal("approve"), headSha: sha }),
  z.object({
    type: z.literal("request_changes"),
    findings: z.array(
      z.object({
        id,
        severity,
        title: text,
        body: text,
        anchor: anchorSchema.nullable(),
      }),
    ),
  }),
  z.object({
    type: z.literal("answer_question"),
    questionId: id,
    answer: text,
  }),
  z.object({
    type: z.literal("answer_provider_request"),
    runId: id,
    requestId: id,
    generation: count.nullable(),
    decision: z.enum(["accept", "decline", "cancel"]),
    answers: z.record(text, z.array(text)).nullable(),
  }),
  z.object({
    type: z.literal("answer_pane_prompt"),
    expectedDialog: z
      .object({
        requestId: z.string(),
        at: time,
        command: z.string(),
        sessionEpoch: z.number().int().nonnegative(),
      })
      .optional(),
    runId: id,
    choice: z.union([
      z.number().int().min(0).max(9),
      z.enum(["enter", "escape"]),
    ]),
    text: text.optional(),
  }),
  z.object({
    type: z.literal("send_message"),
    runId: id,
    text,
    when: z.enum(["now", "after_turn"]).optional(),
    // The coordinator replaces protocol attachment IDs with resolved local image paths before
    // persisting this command. Non-image attachment paths are already appended to text.
    attachmentIds: z.array(text).optional(),
    expectedRun: z
      .object({
        sessionEpoch: z.number().int().nonnegative(),
        attempts: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("interrupt_run"),
    runId: id,
    expectedRun: z.object({
      sessionEpoch: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
    }),
  }),
  z.object({ type: z.literal("retry") }),
  z.object({ type: z.literal("restart_run"), runId: id }),
  z.object({ type: z.literal("grant_review_round") }),
  z.object({ type: z.literal("waive_finding"), findingId: id, note: text }),
  z.object({ type: z.literal("cancel"), reason: text }),
  z.object({ type: z.literal("reopen") }),
]);
export const inputSchema = contract<Input>()(
  z.discriminatedUnion("type", [
    z.object({
      id,
      receivedAt: time,
      type: z.literal("human"),
      command: commandSchema,
    }),
    z.object({
      id,
      receivedAt: time,
      type: z.literal("mcp"),
      runId: id,
      call: callSchema,
    }),
    z.object({
      id,
      receivedAt: time,
      type: z.literal("coordinator"),
      event: z.object({
        type: z.literal("restart_interrupted"),
        runId: id,
        turnId: id,
      }),
    }),
    z.object({
      id,
      receivedAt: time,
      type: z.literal("action_result"),
      key: id,
      result: actionResultSchema,
    }),
  ]),
);
const replySchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("submit_plan"),
    value: z.object({
      planVersion: positive,
      next: z.enum(["plan_approval", "in_progress"]),
    }),
  }),
  z.object({
    tool: z.literal("report_progress"),
    value: z.object({ recorded: z.literal(true) }),
  }),
  z.object({
    tool: z.literal("ask_human"),
    value: z.object({ questionId: id, delivery: z.literal("message") }),
  }),
  z.object({
    tool: z.literal("submit_for_review"),
    value: z.object({ round: positive }),
  }),
  z.object({
    tool: z.literal("submit_review"),
    value: z.object({
      round: positive,
      openBlocking: count,
      next: z.enum([
        "in_review",
        "in_progress",
        "awaiting_approval",
        "blocked",
      ]),
    }),
  }),
  z.object({
    tool: z.literal("resolve_finding"),
    value: z.object({ status: findingStatus }),
  }),
]);
export const dispositionSchema = contract<InputDisposition>()(
  z.discriminatedUnion("accepted", [
    z.object({
      inputId: id,
      accepted: z.literal(true),
      reply: replySchema.nullable(),
    }),
    z.object({
      inputId: id,
      accepted: z.literal(false),
      error: z.object({
        code: z.enum([
          "invalid_input",
          "unknown_run",
          "stale_run",
          "wrong_stage",
          "guard_failed",
        ]),
        message: text,
        details: z.array(text),
      }),
    }),
  ]),
);
