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
const shaSchema = z
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
const status = z.enum([
  "open",
  "addressed",
  "disputed",
  "resolved",
  "fixed",
  "escalate",
  "waived",
]);
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
  "ci",
  "in_review",
  "awaiting_approval",
  "merging",
  "done",
  "canceled",
]);
const planSchema = z.strictObject({
  goal: nonempty,
  nonGoals: texts,
  // Agents submit one-line outcomes; the stored plan keeps its { title, detail } shape.
  steps: z
    .array(
      text
        .trim()
        .min(1)
        .max(200)
        .transform((title) => ({ title, detail: "" })),
    )
    .min(1),
  areas: texts,
  acceptanceCriteria: z.array(nonempty).min(1),
  testPlan: texts,
  risks: texts,
  openQuestions: texts,
  suggestedImplementer: z.enum(["codex", "claude"]).nullable(),
});
/**
 * A plan as stored, which may be Loom's own: a small task's auto-generated plan carries its
 * description as steps and nothing else (core, stages.ts). Agents must submit more
 * (`planSchema`); the context tool must report what exists.
 */
const storedPlanSchema = planSchema.extend({
  goal: text,
  steps: z.array(z.strictObject({ title: text, detail: text })),
  acceptanceCriteria: texts,
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
  get_task_context: z.strictObject({ full: z.boolean().optional() }),
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
  submit_review: z
    .strictObject({
      reviewedSha: shaSchema,
      reviewerCommits: z.array(shaSchema),
      summary: text,
      findings: z.array(
        z.strictObject({
          severity,
          title: text,
          body: text,
          location: location.nullable(),
          status: z.enum(["open", "fixed", "escalate"]).optional(),
          commitSha: shaSchema.optional(),
          reason: nonempty.optional(),
        }),
      ),
      verdicts: z.array(
        z.strictObject({
          findingId: findingIdSchema,
          status: z.enum(["resolved", "reopened", "fixed", "escalate"]),
          note: text,
          commitSha: shaSchema.optional(),
          reason: nonempty.optional(),
        }),
      ),
      testResults: z.array(testInput),
    })
    .superRefine((review, ctx) => {
      for (const [group, items] of [
        ["findings", review.findings],
        ["verdicts", review.verdicts],
      ] as const) {
        items.forEach((item, index) => {
          if (
            item.status === "fixed" &&
            (!item.commitSha ||
              !review.reviewerCommits.includes(item.commitSha))
          )
            ctx.addIssue({
              code: "custom",
              path: [group, index, "commitSha"],
              message: "Fixed findings need a fixing commit in reviewerCommits",
            });
          if (item.status === "escalate" && !item.reason?.trim())
            ctx.addIssue({
              code: "custom",
              path: [group, index, "reason"],
              message: "Explain why this must be fixed before merge",
            });
          if (
            (item.status !== "fixed" && item.commitSha) ||
            (item.status !== "escalate" && item.reason)
          )
            ctx.addIssue({
              code: "custom",
              path: [group, index],
              message:
                "Fix commits and escalation reasons must match the status",
            });
        });
      }
    }),
  resolve_finding: z.strictObject({
    findingId: findingIdSchema,
    resolution: z.enum(["fixed", "disputed"]),
    note: text,
    commitSha: shaSchema.nullable(),
  }),
};
const taskContextTaskSchema = z.strictObject({
  id: id.transform((v) => v as TaskId),
  title: text,
  description: text,
  summary: text.nullable(),
  stage,
  reviewRound: count,
  reviewRoundCap: line,
});
const taskContextRunSchema = z.strictObject({
  id: runIdSchema,
  round: count,
  attempts: line,
});
const taskContextWorktreeSchema = z.strictObject({
  path: text.startsWith("/").transform((v) => v as WorktreePath),
  branch: text,
  baseBranch: text,
  baseSha: shaSchema,
  headSha: shaSchema.nullable(),
  roundHead: shaSchema.nullable().optional(),
  lastReviewedHead: shaSchema.nullable().optional(),
});
const findingViewSchema = z.strictObject({
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
});
const testResultSchema = testInput.extend({
  headSha: shaSchema,
  ranAt: timeSchema,
  runId: runIdSchema,
});
const answeredQuestionSchema = z.strictObject({
  id: questionIdSchema,
  question: text,
  answer: text,
});
const contextHandoffSchema = handoff
  .extend({
    reviewerSubmission: z
      .strictObject({
        runId: runIdSchema,
        round: count,
        input: inputSchemas.submit_review,
      })
      .optional(),
  })
  .nullable();
const fullContextSchema = z.strictObject({
  view: z.literal("full"),
  task: taskContextTaskSchema,
  role,
  run: taskContextRunSchema,
  worktree: taskContextWorktreeSchema,
  brief: text,
  plan: storedPlanSchema.extend({ version: line }).nullable(),
  decisions: text,
  handoff: contextHandoffSchema,
  findings: z.array(findingViewSchema),
  testResults: z.array(testResultSchema),
  answeredQuestions: z.array(answeredQuestionSchema),
  workflow: z.record(z.string(), text),
});
export const outputSchemas = {
  get_task_context: z.discriminatedUnion("view", [
    fullContextSchema,
    z.strictObject({
      view: z.literal("changes"),
      header: z.strictObject({
        task: taskContextTaskSchema.pick({ stage: true, reviewRound: true }),
        run: taskContextRunSchema,
        worktree: taskContextWorktreeSchema.pick({
          baseSha: true,
          headSha: true,
          roundHead: true,
          lastReviewedHead: true,
        }),
      }),
      mustAct: z.array(
        findingViewSchema.pick({ id: true, title: true, status: true }),
      ),
      task: taskContextTaskSchema.optional(),
      worktree: taskContextWorktreeSchema.optional(),
      brief: text.optional(),
      plan: storedPlanSchema.extend({ version: line }).nullable().optional(),
      decisions: text.optional(),
      handoff: contextHandoffSchema.optional(),
      findings: z
        .strictObject({
          changed: z.array(findingViewSchema),
          noLongerVisible: z.array(findingIdSchema),
        })
        .optional(),
      testResults: z.array(testResultSchema).optional(),
      answeredQuestions: z.array(answeredQuestionSchema).optional(),
      workflow: z.record(z.string(), text).optional(),
    }),
  ]),
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
    next: z.enum(["in_review", "in_progress", "awaiting_approval", "blocked"]),
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
