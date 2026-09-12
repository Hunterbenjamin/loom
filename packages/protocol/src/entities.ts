// zod mirrors of the entities the coordinator owns (`@loom/core`'s `entities.ts`). A type-level
// test in `entities.test.ts` keeps every one of them equal to the type it mirrors, so a change to
// core that this package hasn't followed fails typecheck rather than a window.

import type { ProviderRequest } from "@loom/core";
import { z } from "zod";
import {
  approvalId,
  blobOid,
  count,
  findingId,
  inputId,
  isoTime,
  line,
  messageId,
  path,
  providerSessionId,
  questionId,
  repoId,
  runId,
  sha,
  taskId,
  text,
  transitionId,
  worktreePath,
} from "./ids.js";

export const provider = z.enum(["codex", "claude"]);
export const role = z.enum(["planner", "implementer", "reviewer"]);
export const stage = z.enum([
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
export const providerRules = z.strictObject({
  planner: provider,
  implementer: provider,
  reviewer: provider,
});

export const repo = z.strictObject({
  id: repoId,
  root: worktreePath,
  github: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseBranch: z.string().min(1),
  defaultProviders: providerRules,
  serialTests: z.boolean(),
});

// ---------------------------------------------------------------- flags and attention

export const blockedReason = z.enum([
  "dependencies",
  "question",
  "review_round_cap",
  "review_not_converging",
  "provider_cooling_down",
  "pr_closed",
]);
export const blockedFlag = z.strictObject({
  reason: blockedReason,
  since: isoTime,
  detail: text,
  until: isoTime.nullable(),
  questionId: questionId.nullable(),
});
export const failedReason = z.enum([
  "retries_exhausted",
  "non_retryable_error",
  "action_failed",
]);
export const failedFlag = z.strictObject({
  reason: failedReason,
  since: isoTime,
  detail: text,
  runId: runId.nullable(),
});
export const attentionReason = z.enum([
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
]);

/**
 * `reasonSince` is what an inbox sorts by: how long each reason has waited, not how long the set
 * has (PR #18 feedback, gap 2). `@loom/core`'s `deriveAttention` is the only producer.
 */
export const attention = z
  .strictObject({
    reasons: z.array(attentionReason),
    reasonSince: z.partialRecord(attentionReason, isoTime),
    since: isoTime.nullable(),
  })
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

export const task = z.strictObject({
  id: taskId,
  repoId,
  title: text,
  description: text,
  stage,
  stageEnteredAt: isoTime,
  version: count,
  blocked: blockedFlag.nullable(),
  failed: failedFlag.nullable(),
  requirePlanApproval: z.boolean(),
  reviewRound: count,
  reviewRoundCap: count,
  providers: providerRules,
  blockedBy: z.array(taskId),
  budgetMinutes: z.number().int().positive().nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
  worktreePath: worktreePath.nullable(),
  branch: z.string().min(1).nullable(),
  prNumber: z.number().int().positive().nullable(),
  attention,
});

export const worktree = z.strictObject({
  path: worktreePath,
  taskId,
  repoId,
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  baseSha: sha,
  portSlot: count.nullable(),
  paneWorkspaceId: z.string().min(1).nullable(),
  createdAt: isoTime,
  removedAt: isoTime.nullable(),
  git: z
    .strictObject({
      headSha: sha.nullable(),
      dirty: z.boolean(),
      aheadOfBase: count,
      at: isoTime,
    })
    .nullable(),
});

// ---------------------------------------------------------------- run

export const runMode = z.enum(["headless", "interactive"]);
export const runStatus = z.enum([
  "starting",
  "working",
  "blocked",
  "idle",
  "failed",
  "ended",
  "unknown",
]);
export const runBlockedOn = z.enum(["permission", "input", "rate_limit"]);
export const providerRequestKind = z.enum([
  "command_approval",
  "file_approval",
  "permission",
  "question",
]);
export const providerRequest = z.strictObject({
  id: z.string().min(1),
  generation: count.nullable(),
  kind: providerRequestKind,
  blocking: z.boolean().nullable(),
  summary: text,
  receivedAt: isoTime,
});

/** A provider request is only unique within its generation (gap 9). Use this for a list key. */
export const providerRequestKey = (request: ProviderRequest): string =>
  `${request.generation ?? "-"}:${request.id}`;

export const run = z.strictObject({
  id: runId,
  taskId,
  role,
  provider,
  mode: runMode,
  origin: z.enum(["loom", "external"]),
  worktreePath,
  round: count,
  attempts: count,
  // Empty for a session Loom did not launch (core records `model: ""` for external runs). With
  // `min(1)` here, one adopted session made every publish of its task fail and hid the task
  // from every client, CLI included, at the moment it needed attention (2026-09-12).
  model: z.string(),
  sessionId: providerSessionId.nullable(),
  sessionEpoch: count,
  codexGeneration: count.nullable(),
  pane: z
    .strictObject({
      hostGeneration: z.string().min(1),
      sessionName: z.string().min(1),
      windowId: z.string().min(1),
      paneId: z.string().min(1),
    })
    .nullable(),
  status: runStatus,
  blockedOn: runBlockedOn.nullable(),
  lastTurn: z
    .strictObject({
      id: z.string().min(1),
      outcome: z.enum(["completed", "interrupted", "failed"]).nullable(),
      error: text.nullable(),
    })
    .nullable(),
  pendingRequests: z.array(providerRequest),
  lastActivityAt: isoTime.nullable(),
  retryAt: isoTime.nullable(),
  launchedAt: isoTime.nullable(),
  endedAt: isoTime.nullable(),
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
  seenAt: isoTime.nullable().optional(),
  unknownSince: isoTime.nullable().optional(),
  observedAttempt: count.optional(),
  retryBaseAttempt: count.optional(),
});

// ---------------------------------------------------------------- messages and questions

export const sendVia = z.enum([
  "codex_turn_start",
  "codex_turn_steer",
  "pane_paste",
  "claude_sdk",
]);
export const message = z.strictObject({
  id: messageId,
  runId,
  purpose: z.enum(["initial", "fix_round", "answer", "plan_feedback", "human"]),
  text,
  textHash: z.string().min(1),
  status: z.enum(["pending", "sent", "delivered", "failed"]),
  attempts: count,
  transportRef: z.string().min(1).nullable(),
  sentAt: isoTime.nullable(),
  delivered: z
    .union([
      z.strictObject({
        via: z.literal("codex_turn_started"),
        turnId: z.string().min(1),
        at: isoTime,
      }),
      z.strictObject({
        via: z.literal("codex_user_message_item"),
        turnId: z.string().min(1),
        at: isoTime,
      }),
      z.strictObject({
        via: z.literal("claude_user_prompt_submit"),
        promptId: z.string().min(1),
        at: isoTime,
      }),
    ])
    .nullable(),
  via: sendVia.optional(),
  expectedTurnId: z.string().min(1).nullable().optional(),
  baselineTurnId: z.string().min(1).nullable().optional(),
  deliveryAttention: z.boolean().optional(),
});

export const question = z.strictObject({
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

export const plan = z.strictObject({
  goal: text,
  nonGoals: z.array(text),
  steps: z.array(z.strictObject({ title: text, detail: text })),
  areas: z.array(text),
  acceptanceCriteria: z.array(text),
  testPlan: z.array(text),
  risks: z.array(text),
  openQuestions: z.array(text),
  suggestedImplementer: provider.nullable(),
});

export const testResult = z.strictObject({
  command: text,
  outcome: z.enum(["passed", "failed", "skipped", "errored"]),
  summary: text,
  headSha: sha,
  ranAt: isoTime,
  runId,
});

// ---------------------------------------------------------------- findings

export const severity = z.enum(["blocker", "major", "minor", "nit"]);
export const findingStatus = z.enum([
  "open",
  "addressed",
  "disputed",
  "resolved",
  "waived",
]);
export const mappingStatus = z.enum([
  "exact",
  "moved",
  "ambiguous",
  "outdated",
]);
export const side = z.enum(["old", "new"]);

export const findingAnchor = z.strictObject({
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
  selectedTextHash: z.string().min(1),
  contextBeforeHash: z.string().min(1),
  contextAfterHash: z.string().min(1),
  normalization: z.literal("lf-v1"),
});

export const findingLocation = z.strictObject({
  headSha: sha,
  path: path.nullable(),
  blobOid: blobOid.nullable(),
  side,
  startLine: line.nullable(),
  endLine: line.nullable(),
  status: mappingStatus,
  version: count,
  mappedAt: isoTime,
});

export const finding = z.strictObject({
  id: findingId,
  taskId,
  round: count,
  source: z.enum(["reviewer", "human", "github", "ci", "system"]),
  externalId: z.string().min(1).nullable(),
  createdByRunId: runId.nullable(),
  severity,
  blocking: z.boolean(),
  title: text,
  body: text,
  status: findingStatus,
  reopenCount: count,
  anchor: findingAnchor.nullable(),
  location: findingLocation.nullable(),
  resolution: z
    .strictObject({
      by: z.enum(["implementer", "reviewer", "human"]),
      note: text,
      commitSha: sha.nullable(),
      at: isoTime,
    })
    .nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
});

// ---------------------------------------------------------------- approvals

export const ciCheck = z.strictObject({
  name: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.string().nullable(),
  url: z.url().nullable(),
  id: z.string().min(1),
});
export const ciState = z.strictObject({
  headSha: sha,
  conclusion: z.enum(["success", "pending", "failure", "none"]),
  checks: z.array(ciCheck),
  observedAt: isoTime,
});
export const findingsSnapshot = z.strictObject({
  hash: z.string().min(1),
  findings: z.array(
    z.strictObject({ id: findingId, status: findingStatus, severity }),
  ),
  openBlocking: count,
});
export const approvalVoidReason = z.enum([
  "new_commit",
  "ci_failed",
  "findings_changed",
  "plan_changed",
  "stage_left",
]);
const approvalBase = {
  id: approvalId,
  taskId,
  createdAt: isoTime,
  voidedAt: isoTime.nullable(),
  voidReason: approvalVoidReason.nullable(),
};
export const approval = z.union([
  z.strictObject({
    ...approvalBase,
    kind: z.literal("plan"),
    planVersion: count,
  }),
  z.strictObject({
    ...approvalBase,
    kind: z.literal("merge"),
    headSha: sha,
    findings: findingsSnapshot,
    ci: ciState,
  }),
]);

// ---------------------------------------------------------------- transitions

export const transition = z.strictObject({
  id: transitionId,
  taskId,
  at: isoTime,
  from: stage,
  to: stage,
  flags: z.strictObject({
    blocked: z
      .strictObject({
        from: blockedReason.nullable(),
        to: blockedReason.nullable(),
      })
      .optional(),
    failed: z
      .strictObject({
        from: failedReason.nullable(),
        to: failedReason.nullable(),
      })
      .optional(),
  }),
  trigger: z.union([
    z.strictObject({
      kind: z.literal("human"),
      command: z.string().min(1),
      inputId,
    }),
    z.strictObject({
      kind: z.literal("mcp"),
      tool: z.string().min(1),
      runId,
      inputId,
    }),
    z.strictObject({ kind: z.literal("reconcile"), fact: text }),
  ]),
  reason: text,
  taskVersion: count,
});

// ---------------------------------------------------------------- human commands

/** `HumanCommand` from `packages/core/src/observations.ts`, validated at the window's edge. */
export const humanCommand = z.union([
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
  z.strictObject({ type: z.literal("send_message"), runId, text }),
  z.strictObject({ type: z.literal("retry") }),
  z.strictObject({ type: z.literal("grant_review_round") }),
  z.strictObject({ type: z.literal("waive_finding"), findingId, note: text }),
  z.strictObject({ type: z.literal("cancel"), reason: text }),
  z.strictObject({ type: z.literal("reopen") }),
]);
