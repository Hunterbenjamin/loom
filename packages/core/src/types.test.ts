// These checks prove the contracts compile and stay internally consistent;
// `pnpm typecheck` does the real work, and vitest runs them as no-ops.

import { describe, expectTypeOf, it } from "vitest";
import type {
  Action,
  ActionKind,
  ActionOutputs,
  ActionResult,
  IsoTime,
  McpCall,
  McpToolName,
  McpTools,
  Observations,
  ProviderSessionId,
  Reconcile,
  ReconcileResult,
  RepoId,
  Run,
  RunId,
  Stage,
  Task,
  TaskId,
  TaskState,
  WorktreePath,
} from "./index.js";

const now = "2026-09-12T00:00:00Z" as IsoTime;
const taskId = "t1" as TaskId;
const worktreePath = "/private/var/loom/wt/t1" as WorktreePath;

const task: Task = {
  id: taskId,
  repoId: "loom" as RepoId,
  number: 1,
  name: null,
  title: "Add a thing",
  description: "",
  summary: null,
  stage: "in_progress",
  stageEnteredAt: now,
  version: 7,
  blocked: null,
  failed: null,
  requirePlanApproval: false,
  reviewRound: 0,
  reviewRoundCap: 3,
  providers: { planner: "claude", implementer: "codex", reviewer: "claude" },
  blockedBy: [],
  budgetMinutes: null,
  size: "normal",
  createdAt: now,
  updatedAt: now,
  worktreePath,
  branch: "feat/thing",
  prNumber: null,
  attention: { reasons: [], reasonSince: {}, since: null },
};

const run: Run = {
  id: "t1/implementer/0" as RunId,
  taskId,
  role: "implementer",
  provider: "codex",
  mode: "interactive",
  origin: "loom",
  worktreePath,
  round: 0,
  attempts: 1,
  model: "gpt-5.6-luna",
  sessionId: "01a08ff4-b43e-71d3-aae7-fa59a9070465" as ProviderSessionId,
  sessionEpoch: 0,
  codexGeneration: 1,
  pane: {
    hostGeneration: "loom-dev#1757635200",
    sessionName: "loom-t1",
    windowId: "@2",
    paneId: "%3",
  },
  status: "working",
  blockedOn: null,
  lastTurn: null,
  pendingRequests: [],
  lastActivityAt: now,
  retryAt: null,
  launchedAt: now,
  endedAt: null,
  endReason: null,
};

const state: TaskState = {
  issueKey: "LOOM-1",
  task,
  worktree: null,
  runs: [run],
  messages: [],
  questions: [],
  findings: [],
  approvals: [],
  artifacts: [],
  outbox: [],
  consumedInputIds: [],
  artifactContents: {},
  plan: null,
  review: null,
  desiredRun: null,
  activeElapsedMs: 0,
  budgetObservedAt: now,
  progress: null,
  config: {
    deriveClaudeSessionId: (id, epoch) => `${id}#${epoch}` as ProviderSessionId,
    sha256: (text) => `hash:${text}`,
    worktreeRoot: "/tmp/loom",
    baseBranch: "main",
    models: { codex: "test", claude: "test" },
    retry: { baseMs: 10_000, capMs: 300_000, maxAttempts: 3 },
    stallAfterMs: 15 * 60_000,
    fixRoundStallAfterMs: 5 * 60_000,
    unknownGraceMs: 60_000,
    deliveryTimeoutMs: 10_000,
    githubPollMs: 60_000,
    runModes: {
      planner: "interactive",
      implementer: "interactive",
      reviewer: "interactive",
    },
  },
};

const observations: Observations = {
  now,
  git: null,
  github: null,
  runs: [
    {
      runId: run.id,
      resumable: null,
      activityAt: null,
      tokenUsage: null,
      readFailures: { resumable: null, activityAt: null, tokenUsage: null },
      provider: { ok: false, reason: "app-server socket closed", at: now },
      pane: null,
    },
  ],
  externalSessions: {
    ok: true,
    value: [],
    at: "2026-09-12T00:00:00.000Z" as never,
  },
  capacity: {
    version: 1,
    active: { codex: 1, claude: 0 },
    caps: { total: 4, codex: 2, claude: 2 },
    coolingDownUntil: { codex: null, claude: null },
  },
  dependencies: [],
  inputs: [],
};

describe("core contracts", () => {
  it("sample state and observations match the types", () => {
    expectTypeOf(state).toEqualTypeOf<TaskState>();
    expectTypeOf(observations).toEqualTypeOf<Observations>();
  });

  it("reconcile has the documented signature", () => {
    expectTypeOf<Reconcile>().parameters.toEqualTypeOf<
      [TaskState, Observations]
    >();
    expectTypeOf<Reconcile>().returns.toEqualTypeOf<ReconcileResult>();
  });

  it("every action kind has exactly one output type", () => {
    expectTypeOf<ActionKind>().toEqualTypeOf<keyof ActionOutputs>();
    expectTypeOf<ActionResult["kind"]>().toEqualTypeOf<ActionKind>();
    expectTypeOf<
      Extract<ActionResult, { kind: "open_pr"; ok: true }>["output"]
    >().toEqualTypeOf<ActionOutputs["open_pr"]>();
    expectTypeOf<
      Extract<Action, { kind: "merge_pr" }>["matchHeadSha"]
    >().not.toBeAny();
  });

  it("the MCP registry covers every tool, and every submitting tool persists as a call", () => {
    expectTypeOf<keyof McpTools>().toEqualTypeOf<McpToolName>();
    expectTypeOf<McpCall["tool"]>().toEqualTypeOf<
      Exclude<McpToolName, "get_task_context">
    >();
  });

  it("branded IDs don't mix", () => {
    expectTypeOf<TaskId>().not.toEqualTypeOf<RunId>();
    expectTypeOf<string>().not.toExtend<TaskId>();
  });

  it("the stage list is the one in docs/design/core.md", () => {
    expectTypeOf<Stage>().toEqualTypeOf<
      | "backlog"
      | "todo"
      | "planning"
      | "plan_approval"
      | "in_progress"
      | "ci"
      | "in_review"
      | "awaiting_approval"
      | "merging"
      | "done"
      | "canceled"
    >();
  });
});

// These checks fail typecheck if an adapter/store can omit required evidence again.
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

it("requires every persisted task-context field", () => {
  type ContextFields = Pick<
    TaskState,
    | "consumedInputIds"
    | "plan"
    | "review"
    | "desiredRun"
    | "activeElapsedMs"
    | "budgetObservedAt"
    | "progress"
    | "artifactContents"
  >;
  expectTypeOf<OptionalKeys<ContextFields>>().toEqualTypeOf<never>();
  expectTypeOf<TaskState["review"]>()
    .extract<undefined>()
    .toEqualTypeOf<never>();
  expectTypeOf<TaskState["progress"]>()
    .extract<undefined>()
    .toEqualTypeOf<never>();
  expectTypeOf<null>().toExtend<TaskState["plan"]>();
  expectTypeOf<null>().toExtend<TaskState["review"]>();
  expectTypeOf<null>().toExtend<TaskState["desiredRun"]>();
  expectTypeOf<null>().toExtend<TaskState["progress"]>();
});

it("requires owner evidence with explicit unknown semantics", () => {
  type RunEvidence = Pick<
    import("./observations.js").RunObservation,
    "resumable" | "activityAt" | "tokenUsage" | "readFailures"
  >;
  type GitEvidence = Pick<
    import("./observations.js").GitWorktreeObservation,
    "dirtyPaths" | "reachableCommits"
  >;
  expectTypeOf<OptionalKeys<RunEvidence>>().toEqualTypeOf<never>();
  expectTypeOf<OptionalKeys<GitEvidence>>().toEqualTypeOf<never>();
  expectTypeOf<
    OptionalKeys<Pick<import("./entities.js").CiCheck, "id">>
  >().toEqualTypeOf<never>();
  expectTypeOf<RunEvidence["resumable"]>().toEqualTypeOf<boolean | null>();
  expectTypeOf<RunEvidence["activityAt"]>().toEqualTypeOf<IsoTime | null>();
  expectTypeOf<RunEvidence["tokenUsage"]>().toEqualTypeOf<
    import("./entities.js").TokenCounts | null
  >();
  expectTypeOf<RunEvidence["readFailures"]>().toEqualTypeOf<{
    resumable: string | null;
    activityAt: string | null;
    tokenUsage: string | null;
  }>();
  expectTypeOf<import("./entities.js").CiCheck["id"]>().toEqualTypeOf<string>();
});
