import { expect, test } from "vitest";
import { command, finding, fixed, fixture, now } from "../test/fixtures.js";
import { clone } from "./helpers.js";
import type { Input, Run, RunId, Stage } from "./index.js";
import { reconcile } from "./index.js";

function setup(stage: Stage = "in_progress") {
  const f = fixture(stage);
  const role =
    stage === "planning"
      ? "planner"
      : stage === "in_review"
        ? "reviewer"
        : "implementer";
  f.state.runs = f.state.runs.filter((r) => r.role === role);
  const old = f.state.runs[0] as Run;
  f.state.config = {
    ...f.state.config,
    models: { codex: "gpt-5.6-sol", claude: "old-model" },
    providerOverrides: {
      planner: "codex",
      implementer: "codex",
      reviewer: "codex",
    },
    codexReasoningEffort: "medium",
  };
  f.state.findings = [finding()];
  f.observations.inputs = [command({ type: "restart_run", runId: old.id })];
  return { ...f, old };
}

for (const stage of ["planning", "in_progress", "in_review"] as const)
  test(`replacement preserves ${stage} work and waits for retirement`, () => {
    const f = setup(stage);
    if (f.observations.git?.ok) f.observations.git.value.dirty = true;
    const before = clone({
      task: f.state.task,
      plan: f.state.plan,
      review: f.state.review,
      worktree: f.state.worktree,
    });
    const stopped = fixed(f.state, f.observations);
    expect(stopped.inputs[0]?.accepted).toBe(true);
    expect(stopped.next.task.stage).toBe(stage);
    expect(stopped.next.task.reviewRound).toBe(before.task.reviewRound);
    expect(stopped.next.plan).toEqual(before.plan);
    expect(stopped.next.review).toEqual(before.review);
    expect(stopped.next.worktree).toEqual(before.worktree);
    expect(stopped.next.runs[0]).toMatchObject({
      id: f.old.id,
      sessionId: f.old.sessionId,
      model: f.old.model,
      endReason: "superseded",
    });
    expect(stopped.actions.some((a) => a.kind === "start_run")).toBe(false);
    const stop = stopped.actions.find(
      (a) => a.kind === "stop_run" && a.terminate,
    );
    if (!stop) throw new Error("Missing retirement");
    f.observations.inputs = [
      {
        id: "retired" as Input["id"],
        receivedAt: now,
        type: "action_result",
        key: stop.key,
        result: { kind: "stop_run", ok: true, output: {} },
      },
    ];
    const started = fixed(stopped.next, f.observations);
    const launch = started.actions.find((a) => a.kind === "start_run");
    expect(launch).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      resume: false,
      sessionId: null,
      worktreePath: f.old.worktreePath,
      attempt: 1,
    });
    expect(launch?.runId).not.toBe(f.old.id);
    expect(started.next.findings).toEqual(stopped.next.findings);
    // A stale click with a new command ID cannot replace the replacement.
    f.observations.inputs = [
      command({ type: "restart_run", runId: f.old.id }, "second-click"),
    ];
    expect(reconcile(started.next, f.observations).inputs[0]).toMatchObject({
      accepted: false,
    });
    // Nor may the previous provider submit against the preserved task.
    f.observations.inputs = [
      {
        type: "mcp",
        receivedAt: now,
        call: {
          tool: "report_progress",
          input: {
            summary: "late",
            stepIndex: null,
            decisions: [],
            testResults: [],
          },
        },
        runId: f.old.id,
        id: "late-submission" as Input["id"],
      },
    ];
    expect(reconcile(started.next, f.observations).inputs[0]).toMatchObject({
      accepted: false,
      error: { code: "stale_run" },
    });
  });

test("replacement survives capacity waits with captured settings and is idempotent", () => {
  const f = setup();
  const r = fixed(f.state, f.observations);
  expect(fixed(r.next, f.observations).actions).toHaveLength(0);
  const stop = r.next.outbox.find(
    (row) => row.action?.kind === "stop_run" && row.action.terminate,
  );
  if (!stop) throw new Error("Missing retirement");
  stop.status = "succeeded";
  stop.finishedAt = now;
  r.next.config = {
    ...r.next.config,
    models: { codex: "later-model", claude: "later-model" },
    codexReasoningEffort: "low",
  };
  f.observations.inputs = [];
  f.observations.capacity.caps.total = 0;
  const waiting = fixed(r.next, f.observations);
  expect(waiting.next.desiredRun?.replacement?.model).toBe("gpt-5.6-sol");
  expect(waiting.actions.some((a) => a.kind === "start_run")).toBe(false);
  f.observations.capacity.caps.total = 4;
  expect(
    fixed(waiting.next, f.observations).actions.find(
      (a) => a.kind === "start_run",
    ),
  ).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
});

test("restart refuses stale identity, missing git, and another active run", () => {
  for (const change of [
    (f: ReturnType<typeof setup>) => {
      f.observations.inputs = [
        command({ type: "restart_run", runId: "old" as RunId }),
      ];
    },
    (f: ReturnType<typeof setup>) => {
      f.observations.git = { ok: false, at: now, reason: "unavailable" };
    },
    (f: ReturnType<typeof setup>) => {
      f.state.runs.push({
        ...f.old,
        id: "external" as RunId,
        origin: "external",
      });
      f.observations.externalSessions = {
        ok: false,
        at: now,
        reason: "unavailable",
      };
    },
  ]) {
    const f = setup();
    change(f);
    const r = reconcile(f.state, f.observations);
    expect(r.inputs[0]?.accepted).toBe(false);
    expect(r.next.desiredRun?.replacement).toBeUndefined();
  }
});

test("restart cannot bypass approval or terminal stages", () => {
  for (const stage of [
    "plan_approval",
    "awaiting_approval",
    "merging",
    "done",
    "canceled",
    "backlog",
  ] as const) {
    const f = setup();
    f.state.task.stage = stage;
    expect(reconcile(f.state, f.observations).inputs[0]?.accepted).toBe(false);
  }
});
