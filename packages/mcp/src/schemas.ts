import type {
  BlobOid,
  FindingId,
  InputId,
  IsoTime,
  QuestionId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "@loom/core";
import { z } from "zod";

const id = z.string().min(1);
export const runIdSchema = id.transform((v) => v as RunId);
export const inputIdSchema = id.transform((v) => v as InputId);
export const findingIdSchema = id.transform((v) => v as FindingId);
export const questionIdSchema = id.transform((v) => v as QuestionId);
export const shaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .transform((v) => v as Sha);
const blobSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .transform((v) => v as BlobOid);
export const timeSchema = z.iso.datetime().transform((v) => v as IsoTime);
const count = z.number().int().nonnegative();
const line = z.number().int().positive();
const role = z.enum(["planner", "implementer", "reviewer"]);
const side = z.enum(["old", "new"]);
const status = z.enum(["open", "addressed", "disputed", "resolved", "waived"]);
const severity = z.enum(["blocker", "major", "minor", "nit"]);
const text = z.string();
const nonempty = text.refine((s) => s.trim().length > 0, "Must not be blank");
const texts = z.array(text);
const stage = z.enum([
  "backlog",
  "todo",
  "planning",
  "plan_approval",
  "in_progress",
  "in_review",
  "awaiting_approval",
  "merging",
  "done",
  "canceled",
]);
export const planSchema = z.strictObject({
  goal: nonempty,
  nonGoals: texts,
  steps: z.array(z.strictObject({ title: nonempty, detail: text })).min(1),
  areas: texts,
  acceptanceCriteria: z.array(nonempty).min(1),
  testPlan: texts,
  risks: texts,
  openQuestions: texts,
  suggestedImplementer: z.enum(["codex", "claude"]).nullable(),
});
const testInput = z.strictObject({
  command: text,
  outcome: z.enum(["passed", "failed", "skipped", "errored"]),
  summary: text,
});
const handoff = z.strictObject({
  from: role,
  to: role,
  headSha: shaSchema.nullable(),
  summary: text,
  nextSteps: texts,
});
const location = z
  .strictObject({
    path: nonempty.refine(
      (p) => !p.startsWith("/") && !p.split("/").includes(".."),
      "Use a repository-relative path",
    ),
    side,
    startLine: line,
    endLine: line,
  })
  .refine(
    (v) => v.endLine >= v.startLine,
    "endLine must not precede startLine",
  );
export const inputSchemas = {
  get_task_context: z.record(z.string(), z.never()),
  submit_plan: z.strictObject({ plan: planSchema }),
  report_progress: z.strictObject({
    summary: text,
    stepIndex: count.nullable(),
    decisions: texts,
    testResults: z.array(testInput),
  }),
  ask_human: z.strictObject({
    question: nonempty,
    options: texts,
    blocking: z.boolean(),
  }),
  submit_for_review: z.strictObject({
    headSha: shaSchema,
    summary: text,
    testResults: z.array(testInput),
    handoff: z.strictObject({ summary: text, nextSteps: texts }),
  }),
  submit_review: z.strictObject({
    reviewedSha: shaSchema,
    summary: text,
    findings: z.array(
      z.strictObject({
        severity,
        title: text,
        body: text,
        location: location.nullable(),
      }),
    ),
    verdicts: z.array(
      z.strictObject({
        findingId: findingIdSchema,
        status: z.enum(["resolved", "reopened"]),
        note: text,
      }),
    ),
    testResults: z.array(testInput),
  }),
  resolve_finding: z.strictObject({
    findingId: findingIdSchema,
    resolution: z.enum(["fixed", "disputed"]),
    note: text,
    commitSha: shaSchema.nullable(),
  }),
};
export const outputSchemas = {
  get_task_context: z.strictObject({
    task: z.strictObject({
      id: id.transform((v) => v as TaskId),
      title: text,
      description: text,
      summary: text.nullable(),
      stage,
      reviewRound: count,
      reviewRoundCap: line,
    }),
    role,
    run: z.strictObject({ id: runIdSchema, round: count, attempts: line }),
    worktree: z.strictObject({
      path: text.startsWith("/").transform((v) => v as WorktreePath),
      branch: text,
      baseBranch: text,
      baseSha: shaSchema,
      headSha: shaSchema.nullable(),
    }),
    brief: text,
    plan: planSchema.extend({ version: line }).nullable(),
    decisions: text,
    handoff: handoff.nullable(),
    findings: z.array(
      z.strictObject({
        id: findingIdSchema,
        round: count,
        source: text,
        severity,
        blocking: z.boolean(),
        status,
        title: text,
        body: text,
        location: z
          .strictObject({
            path: text.nullable(),
            side,
            startLine: line.nullable(),
            endLine: line.nullable(),
            mapping: z.enum(["exact", "moved", "ambiguous", "outdated"]),
          })
          .nullable(),
        snippet: text.nullable(),
      }),
    ),
    testResults: z.array(
      testInput.extend({
        headSha: shaSchema,
        ranAt: timeSchema,
        runId: runIdSchema,
      }),
    ),
    answeredQuestions: z.array(
      z.strictObject({ id: questionIdSchema, question: text, answer: text }),
    ),
    workflow: z.record(z.string(), text),
  }),
  submit_plan: z.strictObject({
    planVersion: line,
    next: z.enum(["plan_approval", "in_progress"]),
  }),
  report_progress: z.strictObject({ recorded: z.literal(true) }),
  ask_human: z.strictObject({
    questionId: questionIdSchema,
    delivery: z.literal("message"),
  }),
  submit_for_review: z.strictObject({ round: line }),
  submit_review: z.strictObject({
    round: line,
    openBlocking: count,
    next: z.enum(["in_progress", "awaiting_approval", "blocked"]),
  }),
  resolve_finding: z.strictObject({ status }),
};
export const errorSchema = z.strictObject({
  code: z.enum([
    "invalid_input",
    "unknown_run",
    "stale_run",
    "wrong_stage",
    "guard_failed",
  ]),
  message: text,
  details: texts,
});
export const resultSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]);
export const anchorSchema = z.strictObject({
  baseSha: shaSchema,
  headSha: shaSchema,
  oldPath: text.nullable(),
  newPath: text.nullable(),
  oldBlobOid: blobSchema.nullable(),
  newBlobOid: blobSchema.nullable(),
  side,
  startLine: line,
  endLine: line,
  startColumn: count.nullable(),
  endColumn: count.nullable(),
  selectedText: text,
  selectedTextHash: text.regex(/^[0-9a-f]{64}$/),
  contextBeforeHash: text.regex(/^[0-9a-f]{64}$/),
  contextAfterHash: text.regex(/^[0-9a-f]{64}$/),
  normalization: z.literal("lf-v1"),
});
