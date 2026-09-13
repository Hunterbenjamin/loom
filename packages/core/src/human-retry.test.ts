import { expect, test } from "vitest";
import { actionInput, command, fixed, fixture, now } from "../test/fixtures.js";
import type { Run, RunObservation } from "./index.js";
import { reconcile } from "./index.js";

function setup(provider: "codex" | "claude" = "codex") {
  const f = fixture(provider === "codex" ? "in_progress" : "in_review");
  const role = provider === "codex" ? "implementer" : "reviewer";
  f.state.runs = f.state.runs.filter((r) => r.role === role);
  const run = f.state.runs[0] as Run;
  const observation = f.observations.runs.find(
    (r) => r.runId === run.id,
  ) as RunObservation;
  observation.provider = {
    ok: false,
    at: now,
    reason: "Observer disconnected",
  };
  run.status = "unknown";
  run.unknownSince = "2026-09-11T00:00:00.000Z" as typeof now;
  f.observations.inputs = [command({ type: "retry" })];
  return { ...f, run, observation };
}

for (const provider of ["codex", "claude"] as const)
  test(`human retry retires an unknown ${provider} run and starts a fresh session`, () => {
    const f = setup(provider);
    const stopped = fixed(f.state, f.observations);
    expect(stopped.inputs[0]?.accepted).toBe(true);
    expect(stopped.next.runs[0]?.sessionId).toBe(f.run.sessionId);
    expect(stopped.actions.some((a) => a.kind === "start_run")).toBe(false);
    const stop = stopped.actions.find((a) => a.kind === "stop_run");
    if (!stop) throw new Error("Missing retirement");
    expect(stop).toMatchObject({ terminate: true });
    expect(fixed(stopped.next, f.observations).actions).toHaveLength(0);
    f.observations.inputs = [actionInput(stop, {})];
    const started = fixed(stopped.next, f.observations);
    expect(started.actions.find((a) => a.kind === "start_run")).toMatchObject({
      runId: f.run.id,
      attempt: 2,
      sessionEpoch: 1,
      resume: false,
      sessionId:
        provider === "codex"
          ? null
          : f.state.config.deriveClaudeSessionId(f.run.id, 1),
      model: f.run.model,
    });
    expect(started.next.runs[0]).toMatchObject({
      status: "starting",
      unknownSince: null,
    });
    expect(started.next.task.attention.reasons).not.toContain(
      "observability_failure",
    );
    expect(fixed(started.next, f.observations).actions).toHaveLength(0);
  });

test("human retry preserves pending messages under new delivery identities", () => {
  const f = setup();
  f.observations.inputs = [
    command(
      { type: "send_message", runId: f.run.id, text: "Please continue" },
      "message",
    ),
  ];
  const queued = fixed(f.state, f.observations);
  const pending = queued.next.messages[0];
  if (!pending) throw new Error("Missing pending message");
  pending.attempts = 1;
  pending.deliveryAttention = true;
  f.observations.inputs = [command({ type: "retry" })];
  const stopped = fixed(queued.next, f.observations);
  expect(stopped.next.messages.find((m) => m.id === pending.id)?.status).toBe(
    "failed",
  );
  expect(stopped.next.messages.find((m) => m.id !== pending.id)).toMatchObject({
    text: "Please continue",
    status: "pending",
    attempts: 0,
  });
  const stop = stopped.actions.find((a) => a.kind === "stop_run");
  if (!stop) throw new Error("Missing retirement");
  f.observations.inputs = [actionInput(stop, {})];
  const started = fixed(stopped.next, f.observations);
  expect(
    started.next.messages.filter((m) => m.status === "pending"),
  ).toHaveLength(1);
});

test("retry refuses missing worktrees and duplicate pending retries with a reason", () => {
  const f = setup();
  const stopped = fixed(f.state, f.observations);
  f.observations.inputs = [command({ type: "retry" }, "again")];
  expect(reconcile(stopped.next, f.observations).inputs[0]).toMatchObject({
    accepted: false,
    error: {
      code: "guard_failed",
      message: "A run replacement or retry is already pending",
    },
  });
  f.observations.git = { ok: false, at: now, reason: "Unavailable" };
  expect(reconcile(f.state, f.observations).inputs[0]).toMatchObject({
    accepted: false,
    error: { code: "guard_failed" },
  });
});

test.each(["starting", "working", "idle", "blocked"] as const)(
  "human retry also retires a %s run",
  (status) => {
    const f = setup();
    const native = fixture().observations.runs.find(
      (r) => r.runId === f.run.id,
    )?.provider;
    if (!native?.ok || native.value?.provider !== "codex")
      throw new Error("Missing Codex reading");
    f.observation.provider = native;
    if (status === "starting") {
      native.value = null;
      f.run.seenAt = null;
      f.observation.pane = null;
    } else if (status === "blocked")
      native.value.activeFlags = ["waitingOnApproval"];
    else if (status === "working") {
      native.value.status = "active";
      native.value.turns = [
        {
          id: "turn1",
          status: "inProgress",
          error: null,
          userMessageHashes: [],
        },
      ];
    }
    const result = fixed(f.state, f.observations);
    expect(result.inputs[0]?.accepted).toBe(true);
    expect(result.next.desiredRun?.fresh).toBe(true);
    expect(result.actions.find((a) => a.kind === "stop_run")).toMatchObject({
      terminate: true,
    });
  },
);

test("human retry still replaces a failed run when an older action also failed", () => {
  const f = setup();
  const worktree = f.state.worktree;
  const branch = f.state.task.branch;
  const gitReading = f.observations.git;
  const git = gitReading?.ok ? gitReading.value : null;
  if (!worktree || !branch || !git?.headSha)
    throw new Error("Missing retry fixture state");
  f.state.outbox = [
    {
      key: `push_branch:${f.state.task.id}:${git.headSha}` as never,
      kind: "push_branch",
      status: "failed",
      attempts: 3,
      createdAt: now,
      finishedAt: now,
      action: {
        kind: "push_branch",
        taskId: f.state.task.id,
        worktreePath: worktree.path,
        branch,
        expectedHeadSha: git.headSha,
      },
      error: { code: "retryable", message: "Earlier push rejected" },
    },
  ];

  const result = fixed(f.state, f.observations);

  expect(result.inputs[0]?.accepted).toBe(true);
  expect(result.actions.find((a) => a.kind === "stop_run")).toMatchObject({
    runId: f.run.id,
    terminate: true,
  });
  expect(result.next.desiredRun?.fresh).toBe(true);
});

test("failed task actions retry without replacing live runs in the worktree", () => {
  const f = fixture("in_review");
  const planner = f.state.runs.find((r) => r.role === "planner");
  const implementer = f.state.runs.find((r) => r.role === "implementer");
  const reviewer = f.state.runs.find((r) => r.role === "reviewer");
  const worktree = f.state.worktree;
  const branch = f.state.task.branch;
  const gitReading = f.observations.git;
  const git = gitReading?.ok ? gitReading.value : null;
  if (
    !planner ||
    !implementer ||
    !reviewer ||
    !worktree ||
    !branch ||
    !git?.headSha
  )
    throw new Error("Missing retry fixture state");
  planner.endedAt = now;
  reviewer.status = "starting";
  reviewer.seenAt = null;
  const reviewerObservation = f.observations.runs.find(
    (row) => row.runId === reviewer.id,
  );
  if (!reviewerObservation?.provider.ok)
    throw new Error("Missing reviewer observation");
  reviewerObservation.provider.value = null;
  const action = {
    key: `push_branch:${f.state.task.id}:${git.headSha}` as never,
    taskId: f.state.task.id,
    kind: "push_branch" as const,
    worktreePath: worktree.path,
    branch,
    expectedHeadSha: git.headSha,
  };
  f.state.outbox = [
    {
      key: action.key,
      kind: action.kind,
      status: "failed",
      attempts: 3,
      createdAt: now,
      finishedAt: now,
      action,
      error: { code: "retryable", message: "Push rejected" },
    },
  ];
  f.state.task.failed = {
    reason: "action_failed",
    since: now,
    detail: "Push rejected",
    runId: null,
  };
  f.state.messages = [
    {
      id: "review-initial" as never,
      runId: reviewer.id,
      purpose: "initial",
      text: "Review this change",
      textHash: "sha256:review",
      status: "pending",
      pendingSince: "2026-09-11T23:00:00.000Z" as typeof now,
      attempts: 0,
      transportRef: null,
      sentAt: null,
      delivered: null,
      deliveryAttention: true,
    },
  ];
  f.observations.inputs = [command({ type: "retry" })];

  const result = fixed(f.state, f.observations);

  expect(result.inputs[0]?.accepted).toBe(true);
  expect(result.next.task.failed).toBeNull();
  expect(
    result.next.runs.find((r) => r.id === implementer.id)?.endedAt,
  ).toBeNull();
  expect(
    result.next.runs.find((r) => r.id === reviewer.id)?.endedAt,
  ).toBeNull();
  expect(result.actions.some((row) => row.kind === "stop_run")).toBe(false);
  expect(result.next.messages[0]).toMatchObject({
    pendingSince: now,
    deliveryAttention: false,
  });
  expect(result.next.task.attention.reasons).not.toContain("provider_input");
  expect(result.actions.find((row) => row.kind === "push_branch")?.key).toBe(
    `${action.key}#4`,
  );
});

test("failed retirement can itself be retried without discarding the fresh-session intent", () => {
  const f = setup();
  const stopped = fixed(f.state, f.observations);
  const stop = stopped.actions.find((a) => a.kind === "stop_run");
  if (!stop) throw new Error("Missing retirement");
  f.observations.inputs = [
    {
      ...actionInput(stop, {}),
      type: "action_result",
      key: stop.key,
      result: {
        kind: "stop_run",
        ok: false,
        error: { code: "fatal", message: "Could not retire" },
      },
    },
  ];
  const failed = fixed(stopped.next, f.observations);
  expect(failed.actions.some((a) => a.kind === "start_run")).toBe(false);
  f.observations.inputs = [command({ type: "retry" }, "retry-retirement")];
  const retry = fixed(failed.next, f.observations);
  expect(retry.inputs[0]?.accepted).toBe(true);
  const nextStop = retry.actions.find((a) => a.kind === "stop_run");
  if (!nextStop) throw new Error("Missing retirement retry");
  expect(retry.next.desiredRun?.fresh).toBe(true);
  f.observations.inputs = [actionInput(nextStop, {}, "retired")];
  expect(
    fixed(retry.next, f.observations).actions.find(
      (a) => a.kind === "start_run",
    ),
  ).toMatchObject({ sessionEpoch: 1, attempt: 2 });
});

test("a Main message pinned to an earlier run attempt cannot reach its replacement", () => {
  const f = fixture("in_progress");
  const run = f.state.runs.find((r) => r.role === "implementer") as Run;
  f.observations.inputs = [
    command({
      type: "send_message",
      runId: run.id,
      text: "Stale Main note",
      expectedRun: {
        sessionEpoch: run.sessionEpoch,
        attempts: run.attempts - 1,
      },
    }),
  ];
  const result = fixed(f.state, f.observations);
  expect(result.inputs[0]).toMatchObject({
    accepted: false,
    error: { code: "guard_failed" },
  });
  expect(result.next.messages.some((m) => m.text === "Stale Main note")).toBe(
    false,
  );
});
