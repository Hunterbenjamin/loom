import type {
  Approval,
  Artifact,
  Finding,
  FindingAnchor,
  FindingLocation,
  Message,
  Question,
  Repo,
  Run,
  Task,
  TaskState,
  Transition,
  Worktree,
} from "@loom/core";
import { z } from "zod";
import {
  artifactKind,
  blockedReason,
  contract,
  count,
  failedReason,
  findingStatus,
  hash,
  id,
  paneRef,
  positive,
  provider,
  providerRules,
  requestKind,
  role,
  sendVia,
  severity,
  sha,
  side,
  stage,
  text,
  time,
} from "./schema-helpers.js";

export const repoSchema = contract<Repo>()(
  z.object({
    id,
    root: text,
    github: text,
    baseBranch: text,
    defaultProviders: providerRules,
    serialTests: z.boolean(),
  }),
);
const attentionReason = z.enum([
  "plan_needs_approval",
  "needs_approval",
  "question",
  "provider_permission",
  "provider_input",
  "blocked",
  "failed",
  "run_vanished",
  "stalled",
  "status_unknown",
  "over_budget",
  "observability_failure",
]);

export const taskSchema = contract<Task>()(
  z.object({
    signature: z.string().nullable().optional(),
    id,
    repoId: id,
    title: text,
    description: text,
    summary: z
      .string()
      .max(140)
      .regex(/^[^\r\n]*$/, "Summary must be one line")
      .nullable()
      .default(null),
    stage,
    stageEnteredAt: time,
    version: count,
    blocked: z
      .object({
        reason: blockedReason,
        since: time,
        detail: text,
        until: time.nullable(),
        questionId: id.nullable(),
      })
      .nullable(),
    failed: z
      .object({
        reason: failedReason,
        since: time,
        detail: text,
        runId: id.nullable(),
      })
      .nullable(),
    requirePlanApproval: z.boolean(),
    reviewRound: count,
    reviewRoundCap: positive,
    providers: providerRules,
    blockedBy: z.array(id),
    budgetMinutes: z.number().nonnegative().nullable(),
    size: z.enum(["small", "normal"]).default("normal"),
    createdAt: time,
    updatedAt: time,
    worktreePath: text.nullable(),
    branch: text.nullable(),
    prNumber: positive.nullable(),
    attention: z.object({
      reasons: z.array(attentionReason),
      reasonSince: z.partialRecord(attentionReason, time),
      since: time.nullable(),
    }),
  }),
);
export const worktreeSchema = contract<Worktree>()(
  z.object({
    path: text,
    taskId: id,
    repoId: id,
    branch: text,
    baseBranch: text,
    baseSha: sha,
    portSlot: count.nullable(),
    paneWorkspaceId: text.nullable(),
    createdAt: time,
    removedAt: time.nullable(),
    git: z
      .object({
        headSha: sha.nullable(),
        dirty: z.boolean(),
        aheadOfBase: count,
        at: time,
      })
      .nullable(),
  }),
);
export const runSchema = contract<Run>()(
  z.object({
    id,
    taskId: id,
    role,
    provider,
    mode: z.enum(["headless", "interactive"]),
    origin: z.enum(["loom", "external"]),
    worktreePath: text,
    round: count,
    attempts: count,
    model: text,
    reasoningEffort: text.min(1).optional(),
    sessionId: id.nullable(),
    sessionEpoch: count,
    codexGeneration: count.nullable(),
    pane: paneRef.nullable(),
    status: z.enum([
      "starting",
      "working",
      "blocked",
      "idle",
      "failed",
      "ended",
      "unknown",
    ]),
    blockedOn: z.enum(["permission", "input", "rate_limit"]).nullable(),
    lastTurn: z
      .object({
        id,
        outcome: z.enum(["completed", "interrupted", "failed"]).nullable(),
        error: text.nullable(),
      })
      .nullable(),
    pendingRequests: z.array(
      z.object({
        id,
        generation: count.nullable(),
        kind: requestKind,
        blocking: z.boolean().nullable(),
        summary: text,
        receivedAt: time,
      }),
    ),
    pendingDialog: z
      .object({
        requestId: z.string().optional(),
        command: z.string().optional(),
        kind: z.enum(["permission", "input"]),
        tool: z.string(),
        at: time,
      })
      .nullable()
      .optional(),
    lastActivityAt: time.nullable(),
    retryAt: time.nullable(),
    launchedAt: time.nullable(),
    endedAt: time.nullable(),
    endReason: z
      .enum([
        "submitted",
        "superseded",
        "canceled",
        "crashed",
        "vanished",
        "failed",
        "task_done",
      ])
      .nullable(),
    seenAt: time.nullable().optional(),
    unknownSince: time.nullable().optional(),
    observedAttempt: count.optional(),
    retryBaseAttempt: count.optional(),
  }),
);
export const messageSchema = contract<Message>()(
  z.object({
    id,
    runId: id,
    purpose: z.enum([
      "initial",
      "fix_round",
      "answer",
      "plan_feedback",
      "human",
    ]),
    text,
    textHash: hash,
    status: z.enum(["pending", "sent", "delivered", "failed"]),
    attempts: count,
    transportRef: text.nullable(),
    sentAt: time.nullable(),
    delivered: z
      .union([
        z.object({
          via: z.literal("codex_turn_started"),
          turnId: id,
          at: time,
        }),
        z.object({
          via: z.literal("codex_user_message_item"),
          turnId: id,
          at: time,
        }),
        z.object({
          via: z.literal("claude_user_prompt_submit"),
          promptId: text,
          at: time,
        }),
      ])
      .nullable(),
    via: sendVia.optional(),
    expectedTurnId: text.nullable().optional(),
    baselineTurnId: text.nullable().optional(),
    deliveryAttention: z.boolean().optional(),
  }),
);
export const questionSchema = contract<Question>()(
  z.object({
    id,
    taskId: id,
    runId: id,
    question: text,
    options: z.array(text),
    blocking: z.boolean(),
    askedAt: time,
    answer: text.nullable(),
    answeredAt: time.nullable(),
  }),
);
export const artifactSchema = contract<Artifact>()(
  z.object({
    id,
    taskId: id,
    kind: artifactKind,
    version: positive,
    path: text,
    sha256: hash,
    createdBy: z.union([
      z.literal("human"),
      z.literal("coordinator"),
      z.object({ runId: id }),
    ]),
    createdAt: time,
  }),
);
export const planSchema = z.object({
  goal: text,
  nonGoals: z.array(text),
  steps: z.array(z.object({ title: text, detail: text })),
  areas: z.array(text),
  acceptanceCriteria: z.array(text),
  testPlan: z.array(text),
  risks: z.array(text),
  openQuestions: z.array(text),
  suggestedImplementer: provider.nullable(),
});
export const anchorSchema = contract<FindingAnchor>()(
  z.object({
    baseSha: sha,
    headSha: sha,
    oldPath: text.nullable(),
    newPath: text.nullable(),
    oldBlobOid: sha.nullable(),
    newBlobOid: sha.nullable(),
    side,
    startLine: positive,
    endLine: positive,
    startColumn: count.nullable(),
    endColumn: count.nullable(),
    selectedText: text,
    selectedTextHash: hash,
    contextBeforeHash: hash,
    contextAfterHash: hash,
    normalization: z.literal("lf-v1"),
  }),
);
export const locationSchema = contract<FindingLocation>()(
  z.object({
    headSha: sha,
    path: text.nullable(),
    blobOid: sha.nullable(),
    side,
    startLine: positive.nullable(),
    endLine: positive.nullable(),
    status: z.enum(["exact", "moved", "ambiguous", "outdated"]),
    version: positive,
    mappedAt: time,
  }),
);
export const findingSchema = contract<Finding>()(
  z.object({
    id,
    taskId: id,
    round: count,
    source: z.enum(["reviewer", "human", "github", "ci", "system"]),
    externalId: text.nullable(),
    createdByRunId: id.nullable(),
    severity,
    blocking: z.boolean(),
    title: text,
    body: text,
    status: findingStatus,
    reopenCount: count,
    anchor: anchorSchema.nullable(),
    location: locationSchema.nullable(),
    resolution: z
      .object({
        by: z.enum(["implementer", "reviewer", "human"]),
        note: text,
        commitSha: sha.nullable(),
        at: time,
      })
      .nullable(),
    createdAt: time,
    updatedAt: time,
  }),
);
export const ciSchema = z.object({
  headSha: sha,
  conclusion: z.enum(["success", "pending", "failure", "none"]),
  checks: z.array(
    z.object({
      name: text,
      status: z.enum(["queued", "in_progress", "completed"]),
      conclusion: text.nullable(),
      url: text.nullable(),
      id,
    }),
  ),
  observedAt: time,
});
const approvalBase = {
  id,
  taskId: id,
  createdAt: time,
  voidedAt: time.nullable(),
  voidReason: z
    .enum([
      "new_commit",
      "ci_failed",
      "findings_changed",
      "plan_changed",
      "stage_left",
    ])
    .nullable(),
};
export const approvalSchema = contract<Approval>()(
  z.discriminatedUnion("kind", [
    z.object({
      ...approvalBase,
      kind: z.literal("plan"),
      planVersion: positive,
    }),
    z.object({
      ...approvalBase,
      kind: z.literal("merge"),
      headSha: sha,
      findings: z.object({
        hash,
        findings: z.array(z.object({ id, status: findingStatus, severity })),
        openBlocking: count,
      }),
      ci: ciSchema,
    }),
  ]),
);
export const transitionSchema = contract<Transition>()(
  z.object({
    id,
    taskId: id,
    at: time,
    from: stage,
    to: stage,
    flags: z.object({
      blocked: z
        .object({
          from: blockedReason.nullable(),
          to: blockedReason.nullable(),
        })
        .optional(),
      failed: z
        .object({ from: failedReason.nullable(), to: failedReason.nullable() })
        .optional(),
    }),
    trigger: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("human"), command: text, inputId: id }),
      z.object({ kind: z.literal("mcp"), tool: text, runId: id, inputId: id }),
      z.object({ kind: z.literal("reconcile"), fact: text }),
    ]),
    reason: text,
    taskVersion: count,
  }),
);
export type TaskContext = Pick<
  TaskState,
  | "plan"
  | "review"
  | "desiredRun"
  | "activeElapsedMs"
  | "budgetObservedAt"
  | "progress"
>;
export const contextSchema = contract<TaskContext>()(
  z.object({
    plan: planSchema
      .extend({ version: positive, accepted: z.boolean() })
      .nullable(),
    review: z
      .object({
        headSha: sha,
        lastReviewedHead: sha.nullable(),
        previousBlocking: count.nullable(),
        verdictIds: z.array(id),
      })
      .nullable(),
    desiredRun: z
      .object({ role, round: count, resume: z.boolean() })
      .nullable(),
    activeElapsedMs: z.number().nonnegative(),
    budgetObservedAt: time,
    progress: z
      .object({
        runId: id,
        summary: text,
        stepIndex: count.nullable(),
        at: time,
      })
      .nullable(),
  }),
);
