import { expect } from "vitest";
import type {
  Action,
  Finding,
  FindingId,
  HumanCommand,
  Input,
  InputId,
  IsoTime,
  McpCall,
  Observations,
  ProviderSessionId,
  RepoId,
  Run,
  Sha,
  Stage,
  TaskId,
  TaskState,
  WorktreePath,
} from "../src/index.js";
import { reconcile, runId } from "../src/index.js";

export const now = "2026-09-12T00:00:00.000Z" as IsoTime;
export const head = "a".repeat(40) as Sha;
export const base = "b".repeat(40) as Sha;
export const path = "/tmp/loom/t1" as WorktreePath;
export const taskId = "t1" as TaskId;
export const config: TaskState["config"] = {
  deriveClaudeSessionId: (id, epoch) =>
    `uuid:${id}#${epoch}` as ProviderSessionId,
  sha256: (text) => `sha256:${text}`,
  worktreeRoot: "/tmp/loom",
  baseBranch: "main",
  models: { codex: "fake", claude: "fake" },
  retry: { baseMs: 10000, capMs: 300000, maxAttempts: 3 },
  stallAfterMs: 900000,
  unknownGraceMs: 60000,
  deliveryTimeoutMs: 10000,
  githubPollMs: 60000,
  runModes: {
    planner: "interactive",
    implementer: "interactive",
    reviewer: "interactive",
  },
};
export const plan = {
  goal: "Make the change",
  nonGoals: [],
  steps: [{ title: "Implement", detail: "Change code" }],
  areas: ["src"],
  acceptanceCriteria: ["Works"],
  testPlan: ["Tests"],
  risks: [],
  openQuestions: [],
  suggestedImplementer: null,
};
export function run(
  role: Run["role"] = "implementer",
  provider: Run["provider"] = "codex",
  round = role === "reviewer" ? 1 : 0,
): Run {
  const id = runId(taskId, role, round);
  return {
    id,
    taskId,
    role,
    provider,
    mode: config.runModes[role] ?? "interactive",
    origin: "loom",
    worktreePath: path,
    round,
    attempts: 1,
    model: "fake",
    sessionId: `session:${id}` as ProviderSessionId,
    sessionEpoch: 0,
    codexGeneration: 1,
    pane: null,
    status: "idle",
    blockedOn: null,
    lastTurn: null,
    pendingRequests: [],
    lastActivityAt: now,
    retryAt: null,
    launchedAt: now,
    endedAt: null,
    endReason: null,
    seenAt: now,
  };
}
export function fixture(stage: Stage = "in_progress"): {
  state: TaskState;
  observations: Observations;
} {
  const state: TaskState = {
    task: {
      id: taskId,
      repoId: "repo" as RepoId,
      title: "Implement core",
      description: "",
      stage,
      stageEnteredAt: now,
      version: 1,
      blocked: null,
      failed: null,
      requirePlanApproval: false,
      reviewRound: 1,
      reviewRoundCap: 3,
      providers: { planner: "codex", implementer: "codex", reviewer: "claude" },
      blockedBy: [],
      budgetMinutes: null,
      createdAt: now,
      updatedAt: now,
      worktreePath: path,
      branch: "feat/core",
      prNumber: 1,
      attention: { reasons: [], reasonSince: {}, since: null },
    },
    worktree: {
      path,
      taskId,
      repoId: "repo" as RepoId,
      branch: "feat/core",
      baseBranch: "main",
      baseSha: base,
      portSlot: null,
      paneWorkspaceId: "workspace",
      createdAt: now,
      removedAt: null,
      git: null,
    },
    runs: [run("planner"), run(), run("reviewer", "claude")],
    messages: [],
    questions: [],
    findings: [],
    approvals: [],
    artifacts: [],
    outbox: [],
    config,
    consumedInputIds: [],
    artifactContents: {},
    desiredRun: null,
    activeElapsedMs: 0,
    budgetObservedAt: now,
    progress: null,
    plan: { ...plan, version: 1, accepted: true },
    review: {
      headSha: head,
      lastReviewedHead: head,
      previousBlocking: null,
      verdictIds: [],
    },
  };
  const observations: Observations = {
    now,
    git: {
      ok: true,
      at: now,
      value: {
        path,
        exists: true,
        branch: "feat/core",
        headSha: head,
        dirty: false,
        dirtyPaths: [],
        aheadOfBase: 1,
        behindBase: 0,
        conflictsWithBase: false,
        remoteHeadSha: head,
        reachableCommits: [head],
      },
    },
    github: {
      ok: true,
      at: now,
      value: {
        number: 1,
        url: "https://example.test/pr/1",
        state: "open",
        headSha: head,
        baseBranch: "main",
        mergeable: "mergeable",
        autoMergeEnabled: false,
        mergeCommitSha: null,
        mergedAt: null,
        ci: {
          headSha: head,
          conclusion: "success",
          checks: [],
          observedAt: now,
        },
        reviews: [],
        comments: [],
      },
    },
    runs: [],
    externalSessions: [],
    capacity: {
      version: 4,
      active: { codex: 0, claude: 0 },
      caps: { total: 4, codex: 4, claude: 4 },
      coolingDownUntil: { codex: null, claude: null },
    },
    dependencies: [],
    inputs: [],
  };
  observations.runs = state.runs.map((r) => ({
    runId: r.id,
    resumable: true,
    activityAt: null,
    pane: null,
    provider: {
      ok: true,
      at: now,
      value:
        r.provider === "codex"
          ? {
              provider: "codex",
              threadId: r.sessionId as ProviderSessionId,
              generation: 1,
              status: "idle",
              activeFlags: [],
              turns: [],
              lastError: null,
              pendingRequests: [],
              rateLimits: { usageAllowed: true, resetsAt: null },
            }
          : {
              provider: "claude",
              sessionId: r.sessionId as ProviderSessionId,
              agentsEntry: {
                sessionId: r.sessionId as ProviderSessionId,
                status: "idle",
                rawStatus: "idle",
                kind: "other",
                pid: null,
                cwd: path,
              },
              hooks: {
                lastEventAt: null,
                pendingDialog: null,
                promptSubmits: [],
                lastStop: null,
                stopFailure: null,
                sessionStart: { source: "startup", at: now },
                sessionEnd: null,
              },
              headless: null,
            },
    },
  }));
  return { state, observations };
}
export function command(command: HumanCommand, id = "input1"): Input {
  return { id: id as InputId, receivedAt: now, type: "human", command };
}
export function mcp(
  call: McpCall,
  role: Run["role"] = "implementer",
  id = "input1",
): Input {
  return {
    id: id as InputId,
    receivedAt: now,
    type: "mcp",
    runId: runId(taskId, role, role === "reviewer" ? 1 : 0),
    call,
  };
}
export function finding(id = "f1", extra: Partial<Finding> = {}): Finding {
  return {
    id: id as FindingId,
    taskId,
    round: 1,
    source: "reviewer",
    externalId: null,
    createdByRunId: null,
    severity: "major",
    blocking: true,
    title: "Fix bug",
    body: "Details",
    status: "open",
    reopenCount: 0,
    anchor: null,
    location: null,
    resolution: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}
export function reviewCall(findings: Finding[] = []): McpCall {
  return {
    tool: "submit_review",
    input: {
      reviewedSha: head,
      summary: "Reviewed",
      findings: findings.map((f) => ({
        severity: f.severity,
        title: f.title,
        body: f.body,
        location: null,
      })),
      verdicts: [],
      testResults: [],
    },
    drafts: findings.map((f) => ({ id: f.id, anchor: null })),
  };
}
export const submit = (): McpCall => ({
  tool: "submit_for_review",
  input: {
    headSha: head,
    summary: "Ready",
    testResults: [],
    handoff: { summary: "Ready", nextSteps: [] },
  },
});
export function actionInput(
  action: Action,
  output: unknown,
  id = "action-input",
): Input {
  return {
    id: id as InputId,
    receivedAt: now,
    type: "action_result",
    key: action.key,
    result: { kind: action.kind, ok: true, output },
  } as Input;
}
export function fixed(
  state: TaskState,
  observations: Observations,
): ReturnType<typeof reconcile> {
  const first = reconcile(state, observations);
  const again = reconcile(first.next, observations);
  expect(again.transitions).toEqual([]);
  expect(
    again.actions.filter(
      (a) => !first.next.outbox.some((row) => row.key === a.key),
    ),
  ).toEqual([]);
  expect(reconcile(state, observations)).toEqual(first);
  return first;
}
