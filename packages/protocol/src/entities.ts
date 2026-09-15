import {
  ACCESS_PRESET_VALUES,
  APPROVAL_AUTHOR_VALUES,
  APPROVAL_VOID_REASON_VALUES,
  ARTIFACT_KIND_VALUES,
  ATTENTION_REASON_VALUES,
  BLOCKED_REASON_VALUES,
  CI_CHECK_STATUS_VALUES,
  CI_CONCLUSION_VALUES,
  DIALOG_KIND_VALUES,
  FAILED_REASON_VALUES,
  FINDING_RESOLVER_VALUES,
  FINDING_SOURCE_VALUES,
  FINDING_STATUS_VALUES,
  MAPPING_STATUS_VALUES,
  MERGE_POLICY_VALUES,
  MESSAGE_PURPOSE_VALUES,
  MESSAGE_STATUS_VALUES,
  MESSAGE_WHEN_VALUES,
  PROVIDER_REQUEST_KIND_VALUES,
  PROVIDER_VALUES,
  RESTART_OUTCOME_VALUES,
  ROLE_VALUES,
  RUN_BLOCKED_ON_VALUES,
  RUN_END_REASON_VALUES,
  RUN_MODE_VALUES,
  RUN_ORIGIN_VALUES,
  RUN_STATUS_VALUES,
  SEND_VIA_VALUES,
  SEVERITY_VALUES,
  SIDE_VALUES,
  STAGE_VALUES,
  TASK_SIZE_VALUES,
  TEST_OUTCOME_VALUES,
  TURN_OUTCOME_VALUES,
} from "@loom/core";
import { roleProfile } from "./settings.js";
// Entity fields are defined once here. Wire and storage policies retain their existing
// validation contracts; type-level tests keep the results equal to core.

import type { ProviderRequest } from "@loom/core";
import { z } from "zod";
import * as ids from "./ids.js";
import {
  count,
  findingId,
  isoTime,
  messageId,
  questionId,
  runId,
  sha,
  text,
} from "./ids.js";

export const provider = z.enum(PROVIDER_VALUES);
export const role = z.enum(ROLE_VALUES);
export const stage = z.enum(STAGE_VALUES);
export const blockedReason = z.enum(BLOCKED_REASON_VALUES);
export const failedReason = z.enum(FAILED_REASON_VALUES);
export const attentionReason = z.enum(ATTENTION_REASON_VALUES);
export const runMode = z.enum(RUN_MODE_VALUES);
export const runStatus = z.enum(RUN_STATUS_VALUES);
export const runBlockedOn = z.enum(RUN_BLOCKED_ON_VALUES);
export const providerRequestKind = z.enum(PROVIDER_REQUEST_KIND_VALUES);
export const sendVia = z.enum(SEND_VIA_VALUES);
export const severity = z.enum(SEVERITY_VALUES);
export const findingStatus = z.enum(FINDING_STATUS_VALUES);
export const mappingStatus = z.enum(MAPPING_STATUS_VALUES);
export const side = z.enum(SIDE_VALUES);
export const approvalVoidReason = z.enum(APPROVAL_VOID_REASON_VALUES);
export const artifactKind = z.enum(ARTIFACT_KIND_VALUES);
/** A provider request is only unique within its generation (gap 9). Use this for a list key. */
export const providerRequestKey = (request: ProviderRequest): string =>
  `${request.generation ?? "-"}:${request.id}`;

/** Rows predate strict wire validation. Keep unknown-key stripping and legacy scalar rules
 * here, at schema construction, so sharing a field never makes old rows unreadable. */
function entitySchemas(storage: boolean) {
  const object = <S extends z.ZodRawShape>(shape: S) =>
    storage ? z.object(shape) : z.strictObject(shape);
  const storedId = <T extends z.ZodType<string>>(wire: T) =>
    storage
      ? z
          .string()
          .min(1)
          .transform((value) => value as z.output<T>)
      : wire;
  const { count, line, isoTime, sha, blobOid, text } = ids;
  const approvalId = storedId(ids.approvalId);
  const artifactId = storedId(ids.artifactId);
  const findingId = storedId(ids.findingId);
  const inputId = storedId(ids.inputId);
  const messageId = storedId(ids.messageId);
  const providerSessionId = storedId(ids.providerSessionId);
  const questionId = storedId(ids.questionId);
  const repoId = storedId(ids.repoId);
  const runId = storedId(ids.runId);
  const taskId = storedId(ids.taskId);
  const transitionId = storedId(ids.transitionId);
  const worktreePath = storage
    ? text.transform((value) => value as z.output<typeof ids.worktreePath>)
    : ids.worktreePath;
  const path = storage ? text : ids.path;
  const nonemptyOnWire = storage ? text : text.min(1);
  const storageHash = text.regex(/^[0-9a-f]{64}$/);
  const hash = storage ? storageHash : text.min(1);
  const taskSummary = text
    .max(140)
    .regex(/^[^\r\n]*$/, "Summary must be one line")
    .nullable();
  const paneRef = object({
    hostGeneration: nonemptyOnWire,
    sessionName: nonemptyOnWire,
    windowId: nonemptyOnWire,
    paneId: nonemptyOnWire,
  });
  const transportAttempt = object({
    startedAt: isoTime,
    completedAt: isoTime,
    sessionId: providerSessionId,
    sessionEpoch: count,
    runAttempt: z.number().int().positive(),
  }).refine((attempt) => attempt.completedAt >= attempt.startedAt, {
    message: "Transport completion precedes its start",
  });

  const providerRules = object({
    planner: provider,
    implementer: provider,
    reviewer: provider,
  });

  const repo = object({
    id: repoId,
    root: worktreePath,
    github: storage ? text : z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  });

  // ---------------------------------------------------------------- flags and attention

  const blockedFlag = object({
    reason: blockedReason,
    since: isoTime,
    detail: text,
    until: isoTime.nullable(),
    questionId: questionId.nullable(),
  });

  const failedFlag = object({
    reason: failedReason,
    since: isoTime,
    detail: text,
    runId: runId.nullable(),
  });

  /**
   * `reasonSince` is what an inbox sorts by: how long each reason has waited, not how long the set
   * has (PR #18 feedback, gap 2). `@loom/core`'s `deriveAttention` is the only producer.
   */
  const attentionBase = object({
    reasons: z.array(attentionReason),
    reasonSince: z.partialRecord(attentionReason, isoTime),
    since: isoTime.nullable(),
  });
  const attention = storage
    ? attentionBase
    : attentionBase
        .refine(
          (v) =>
            v.reasons.length === Object.keys(v.reasonSince).length &&
            v.reasons.every((r) => v.reasonSince[r] !== undefined),
          "reasonSince must have exactly one entry per reason",
        )
        .refine((v) => {
          const since = v.since;
          if (v.reasons.length === 0) return since === null;
          return (
            since !== null &&
            v.reasons.every((r) => (v.reasonSince[r] ?? "") >= since)
          );
        }, "since must be the earliest reasonSince");

  // ---------------------------------------------------------------- task and worktree

  const task = object({
    signature: z.string().nullable().optional(),
    id: taskId,
    repoId,
    number: z.number().int().positive(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[^\r\n]*$/, "Name must be one line")
      .nullable(),
    title: text,
    description: text,
    summary: storage ? taskSummary.default(null) : taskSummary,
    stage,
    stageEnteredAt: isoTime,
    version: count,
    blocked: blockedFlag.nullable(),
    failed: failedFlag.nullable(),
    requirePlanApproval: z.boolean(),
    mergePolicy: z.enum(MERGE_POLICY_VALUES).optional(),
    roleProfiles: z.partialRecord(role, roleProfile.strip()).optional(),
    reviewRound: count,
    reviewRoundCap: storage ? line : count,
    providers: providerRules,
    blockedBy: z.array(taskId),
    budgetMinutes: (storage
      ? z.number().nonnegative()
      : z.number().int().positive()
    ).nullable(),
    size: z.enum(TASK_SIZE_VALUES).default("normal"),
    createdAt: isoTime,
    updatedAt: isoTime,
    worktreePath: worktreePath.nullable(),
    branch: nonemptyOnWire.nullable(),
    prNumber: z.number().int().positive().nullable(),
    attention,
  });

  const worktree = object({
    path: worktreePath,
    taskId,
    repoId,
    branch: nonemptyOnWire,
    baseBranch: nonemptyOnWire,
    baseSha: sha,
    portSlot: count.nullable(),
    paneWorkspaceId: nonemptyOnWire.nullable(),
    createdAt: isoTime,
    removedAt: isoTime.nullable(),
    git: object({
      headSha: sha.nullable(),
      dirty: z.boolean(),
      aheadOfBase: count,
      at: isoTime,
    }).nullable(),
  });

  // ---------------------------------------------------------------- run

  const providerRequest = object({
    id: z.string().min(1),
    generation: count.nullable(),
    kind: providerRequestKind,
    blocking: z.boolean().nullable(),
    summary: text,
    receivedAt: isoTime,
  });

  const tokenCounts = object({
    input: count,
    cachedInput: count,
    output: count,
    reasoning: count,
  });

  const run = object({
    id: runId,
    taskId,
    role,
    provider,
    mode: runMode,
    origin: z.enum(RUN_ORIGIN_VALUES),
    worktreePath,
    round: count,
    attempts: count,
    // Empty for a session Loom did not launch (core records `model: ""` for external runs). With
    // `min(1)` here, one adopted session made every publish of its task fail and hid the task
    // from every client, CLI included, at the moment it needed attention (2026-09-12).
    model: z.string(),
    reasoningEffort: z.string().min(1).optional(),
    access: z.enum(ACCESS_PRESET_VALUES),
    fixReason: z.string().min(1).optional(),
    sessionId: providerSessionId.nullable(),
    sessionEpoch: count,
    tokenUsage: z
      .array(
        object({
          sessionId: providerSessionId,
          counts: tokenCounts,
          observedAt: isoTime,
        }),
      )
      .optional(),
    codexGeneration: count.nullable(),
    pane: paneRef.nullable(),
    status: runStatus,
    blockedOn: runBlockedOn.nullable(),
    lastTurn: object({
      id: z.string().min(1),
      outcome: z.enum(TURN_OUTCOME_VALUES).nullable(),
      error: text.nullable(),
    }).nullable(),
    inFlightTurnId: z.string().min(1).nullable().optional(),
    restartInterruption: object({
      turnId: z.string().min(1),
      recordedAt: isoTime,
      outcome: z.enum(RESTART_OUTCOME_VALUES).nullable(),
      decidedAt: isoTime.nullable(),
    })
      .nullable()
      .optional(),
    pendingRequests: z.array(providerRequest),
    pendingDialog: z
      .object({
        requestId: z.string().optional(),
        command: z.string().optional(),
        kind: z.enum(DIALOG_KIND_VALUES),
        tool: z.string(),
        at: isoTime,
      })
      .nullable()
      .optional(),
    lastActivityAt: isoTime.nullable(),
    retryAt: isoTime.nullable(),
    launchedAt: isoTime.nullable(),
    endedAt: isoTime.nullable(),
    endReason: z.enum(RUN_END_REASON_VALUES).nullable(),
    seenAt: isoTime.nullable().optional(),
    unknownSince: isoTime.nullable().optional(),
    idleSince: isoTime.nullable(),
    observedAttempt: count.optional(),
    retryBaseAttempt: count.optional(),
  });

  // ---------------------------------------------------------------- messages and questions

  const message = object({
    id: messageId,
    runId,
    purpose: z.enum(MESSAGE_PURPOSE_VALUES),
    text,
    when: z.enum(MESSAGE_WHEN_VALUES),
    images: z.array(z.string()).optional(),
    textHash: hash,
    status: z.enum(MESSAGE_STATUS_VALUES),
    attempts: count,
    transportRef: nonemptyOnWire.nullable(),
    sentAt: isoTime.nullable(),
    transportAttempt: transportAttempt.optional(),
    delivered: z
      .union([
        object({
          via: z.literal("codex_turn_started"),
          turnId: z.string().min(1),
          at: isoTime,
        }),
        object({
          via: z.literal("codex_user_message_item"),
          turnId: z.string().min(1),
          at: isoTime,
        }),
        object({
          via: z.literal("claude_user_prompt_submit"),
          promptId: nonemptyOnWire,
          at: isoTime,
        }),
      ])
      .nullable(),
    via: sendVia.optional(),
    expectedTurnId: nonemptyOnWire.nullable().optional(),
    baselineTurnId: nonemptyOnWire.nullable().optional(),
    deliveryAttention: z.boolean().optional(),
    deliveryReason: z.string().nullable().optional(),
    pendingSince: isoTime,
  });

  const question = object({
    id: questionId,
    taskId,
    runId,
    question: text,
    options: z.array(text),
    blocking: z.boolean(),
    askedAt: isoTime,
    answer: text.nullable(),
    answeredAt: isoTime.nullable(),
  });

  // ---------------------------------------------------------------- plan and tests

  const plan = object({
    goal: text,
    nonGoals: z.array(text),
    steps: z.array(object({ title: text, detail: text })),
    areas: z.array(text),
    acceptanceCriteria: z.array(text),
    testPlan: z.array(text),
    risks: z.array(text),
    openQuestions: z.array(text),
    suggestedImplementer: provider.nullable(),
  });

  const testResult = object({
    command: text,
    outcome: z.enum(TEST_OUTCOME_VALUES),
    summary: text,
    headSha: sha,
    ranAt: isoTime,
    runId,
  });

  // ---------------------------------------------------------------- findings

  const findingAnchor = object({
    baseSha: sha,
    headSha: sha,
    oldPath: path.nullable(),
    newPath: path.nullable(),
    oldBlobOid: blobOid.nullable(),
    newBlobOid: blobOid.nullable(),
    side,
    startLine: line,
    endLine: line,
    startColumn: count.nullable(),
    endColumn: count.nullable(),
    selectedText: text,
    selectedTextHash: hash,
    contextBeforeHash: hash,
    contextAfterHash: hash,
    normalization: z.literal("lf-v1"),
  });

  const findingLocation = object({
    headSha: sha,
    path: path.nullable(),
    blobOid: blobOid.nullable(),
    side,
    startLine: line.nullable(),
    endLine: line.nullable(),
    status: mappingStatus,
    version: storage ? line : count,
    mappedAt: isoTime,
  });

  const finding = object({
    id: findingId,
    taskId,
    round: count,
    source: z.enum(FINDING_SOURCE_VALUES),
    externalId: nonemptyOnWire.nullable(),
    createdByRunId: runId.nullable(),
    severity,
    blocking: z.boolean(),
    title: text,
    body: text,
    status: findingStatus,
    reopenCount: count,
    anchor: findingAnchor.nullable(),
    location: findingLocation.nullable(),
    resolution: object({
      by: z.enum(FINDING_RESOLVER_VALUES),
      note: text,
      commitSha: sha.nullable(),
      at: isoTime,
    }).nullable(),
    createdAt: isoTime,
    updatedAt: isoTime,
  });

  // ---------------------------------------------------------------- approvals

  const ciCheck = object({
    name: nonemptyOnWire,
    status: z.enum(CI_CHECK_STATUS_VALUES),
    conclusion: z.string().nullable(),
    url: (storage ? text : z.url()).nullable(),
    id: z.string().min(1),
  });
  const ciState = object({
    headSha: sha,
    conclusion: z.enum(CI_CONCLUSION_VALUES),
    checks: z.array(ciCheck),
    observedAt: isoTime,
  });
  const findingsSnapshot = object({
    hash: hash,
    findings: z.array(
      object({ id: findingId, status: findingStatus, severity }),
    ),
    openBlocking: count,
  });

  const approvalBase = {
    id: approvalId,
    taskId,
    createdAt: isoTime,
    voidedAt: isoTime.nullable(),
    voidReason: approvalVoidReason.nullable(),
  };
  const approval = z.union([
    object({
      ...approvalBase,
      kind: z.literal("plan"),
      planVersion: storage ? line : count,
    }),
    object({
      ...approvalBase,
      kind: z.literal("merge"),
      headSha: sha,
      findings: findingsSnapshot,
      ci: ciState,
      approvedBy: z.enum(APPROVAL_AUTHOR_VALUES),
    }),
  ]);

  // ---------------------------------------------------------------- transitions

  const transition = object({
    id: transitionId,
    taskId,
    at: isoTime,
    from: stage,
    to: stage,
    flags: object({
      blocked: object({
        from: blockedReason.nullable(),
        to: blockedReason.nullable(),
      }).optional(),
      failed: object({
        from: failedReason.nullable(),
        to: failedReason.nullable(),
      }).optional(),
    }),
    trigger: z.union([
      object({
        kind: z.literal("human"),
        command: nonemptyOnWire,
        inputId,
      }),
      object({
        kind: z.literal("mcp"),
        tool: nonemptyOnWire,
        runId,
        inputId,
      }),
      object({ kind: z.literal("reconcile"), fact: text }),
    ]),
    reason: text,
    taskVersion: count,
  });

  const artifact = object({
    id: artifactId,
    taskId,
    kind: artifactKind,
    version: line,
    path: text,
    sha256: storageHash,
    createdBy: z.union([
      z.literal("human"),
      z.literal("coordinator"),
      object({ runId }),
    ]),
    createdAt: isoTime,
  });
  const taskContext = object({
    plan: plan.extend({ version: line, accepted: z.boolean() }).nullable(),
    review: object({
      headSha: sha,
      lastReviewedHead: sha.nullable(),
      previousBlocking: count.nullable(),
      verdictIds: z.array(findingId),
      publicationPending: z.boolean().optional(),
      reviewerCommits: z.array(sha).optional(),
      baseSyncRounds: count.optional(),
      nextRoundForBaseSync: z.boolean().optional(),
    }).nullable(),
    ciGate: object({
      headSha: sha,
      since: isoTime,
      ci: ciState
        .omit({ headSha: true })
        .extend({
          checks: z.array(ciCheck.omit({ id: true })),
        })
        .nullable()
        .optional(),
    })
      .nullable()
      .optional(),
    desiredRun: object({
      role,
      round: count,
      resume: z.boolean(),
      retireRunId: runId.optional(),
      fixReason: text.min(1).optional(),
      fresh: z.boolean().optional(),
      replacement: object({
        runId,
        previousRunId: runId,
        provider,
        model: text,
        reasoningEffort: text.optional(),
        mode: z.enum(RUN_MODE_VALUES).optional(),
        access: z.enum(ACCESS_PRESET_VALUES).optional(),
      }).optional(),
    }).nullable(),
    activeElapsedMs: z.number().nonnegative(),
    budgetObservedAt: isoTime,
    progress: object({
      runId,
      summary: text,
      stepIndex: count.nullable(),
      at: isoTime,
    }).nullable(),
  });

  return {
    providerRules,
    repo,
    blockedFlag,
    failedFlag,
    attention,
    task,
    worktree,
    providerRequest,
    tokenCounts,
    run,
    message,
    question,
    plan,
    testResult,
    findingAnchor,
    findingLocation,
    finding,
    ciCheck,
    ciState,
    findingsSnapshot,
    approval,
    transition,
    paneRef,
    transportAttempt,
    artifact,
    taskContext,
  };
}

export const {
  providerRules,
  repo,
  blockedFlag,
  failedFlag,
  attention,
  task,
  worktree,
  providerRequest,
  tokenCounts,
  run,
  message,
  question,
  plan,
  testResult,
  findingAnchor,
  findingLocation,
  finding,
  ciCheck,
  ciState,
  findingsSnapshot,
  approval,
  transition,
  paneRef,
  transportAttempt,
  artifact,
  taskContext,
} = entitySchemas(false);

const stored = entitySchemas(true);
export const storedEntities = {
  ...stored,
  // deliveryReason is derived afresh by reconciliation; historical reads discard it.
  message: stored.message.omit({ deliveryReason: true }),
};

// ---------------------------------------------------------------- human commands

export const editTask = z.strictObject({
  type: z.literal("edit_task"),
  expectedVersion: count,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000),
  size: z.enum(TASK_SIZE_VALUES),
  requirePlanApproval: z.boolean(),
});

/** `HumanCommand` from `packages/core/src/observations.ts`, validated at the window's edge. */
export const humanCommand = z.union([
  editTask,
  z.object({ type: z.literal("push_branch"), headSha: sha }),
  z.object({ type: z.literal("open_pr"), headSha: sha }),
  z.strictObject({
    type: z.literal("move"),
    to: z.enum(["backlog", "todo"]),
  }),
  z.strictObject({ type: z.literal("approve_plan"), planVersion: count }),
  z.strictObject({ type: z.literal("reject_plan"), feedback: text }),
  z.strictObject({ type: z.literal("approve"), headSha: sha }),
  z.strictObject({
    type: z.literal("request_changes"),
    findings: z.array(
      z.strictObject({
        id: findingId,
        severity,
        title: text,
        body: text,
        anchor: findingAnchor.nullable(),
      }),
    ),
  }),
  z.strictObject({
    type: z.literal("answer_question"),
    questionId,
    answer: text,
  }),
  z.strictObject({
    type: z.literal("answer_provider_request"),
    runId,
    requestId: z.string().min(1),
    generation: count.nullable(),
    decision: z.enum(["accept", "decline", "cancel"]),
    answers: z.record(z.string(), z.array(text)).nullable(),
  }),
  z.strictObject({
    type: z.literal("answer_pane_prompt"),
    expectedDialog: z
      .object({
        requestId: z.string(),
        at: isoTime,
        command: z.string().optional(),
        sessionEpoch: z.number().int().nonnegative(),
      })
      .optional(),
    runId,
    choice: z.union([
      z.number().int().min(0).max(9),
      z.enum(["enter", "escape"]),
    ]),
    text: text.optional(),
  }),
  z.strictObject({
    type: z.literal("send_message"),
    runId,
    text,
    when: z.enum(MESSAGE_WHEN_VALUES).optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    expectedRun: z
      .object({
        sessionEpoch: z.number().int().nonnegative(),
        attempts: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.strictObject({ type: z.literal("steer_message"), messageId }),
  z.strictObject({
    type: z.literal("interrupt_run"),
    runId,
    expectedRun: z.object({
      sessionEpoch: z.number().int().nonnegative(),
      attempts: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({ type: z.literal("retry") }),
  z.strictObject({ type: z.literal("restart_run"), runId }),
  z.strictObject({ type: z.literal("grant_review_round") }),
  z.strictObject({ type: z.literal("waive_finding"), findingId, note: text }),
  z.strictObject({ type: z.literal("cancel"), reason: text }),
  z.strictObject({ type: z.literal("reopen") }),
]);
