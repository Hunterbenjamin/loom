import { describe, expect, it } from "vitest";
import {
  actionInput,
  base,
  command,
  fixed,
  fixture,
  head,
  run as makeRun,
  now,
} from "../test/fixtures.js";
import type { Input, Run, RunObservation } from "./index.js";
import { reconcile, runId } from "./index.js";

function failure(mode: "headless" | "interactive" = "headless") {
  const f = fixture("planning");
  const run = f.state.runs[0] as Run;
  run.mode = mode;
  const observation = f.observations.runs[0] as RunObservation;
  if (
    observation.provider.ok &&
    observation.provider.value?.provider === "codex"
  )
    observation.provider.value.status = "systemError";
  return { ...f, run, observation };
}
describe("headless retries and interactive control", () => {
  it("schedules headless backoff without flagging the task", () => {
    const f = failure();
    const r = fixed(f.state, f.observations);
    expect(r.next.runs[0]?.retryAt).toBe("2026-09-12T00:00:10.000Z");
    expect(r.next.task.failed).toBeNull();
    expect(r.actions.find((a) => a.kind === "schedule")).toMatchObject({
      why: "retry",
    });
  });
  it("retries same row and session after fresh git read", () => {
    const f = failure();
    const failed = reconcile(f.state, f.observations);
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    const r = fixed(failed.next, f.observations);
    expect(r.actions.find((a) => a.kind === "start_run")).toMatchObject({
      key: `start_run:${f.run.id}#2`,
      runId: f.run.id,
      attempt: 2,
      sessionId: f.run.sessionId,
      resume: true,
    });
    expect(r.next.runs.length).toBe(3);
  });
  it("does not retry without fresh git state", () => {
    const f = failure();
    const failed = reconcile(f.state, f.observations);
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    f.observations.git = { ok: false, at: now, reason: "Unavailable" };
    const r = fixed(failed.next, f.observations);
    expect(r.actions.some((a) => a.kind === "start_run")).toBe(false);
    expect(r.actions.some((a) => a.kind === "refresh")).toBe(true);
  });
  it("does not retry before the deadline or above capacity", () => {
    const f = failure();
    const failed = reconcile(f.state, f.observations);
    expect(
      fixed(failed.next, f.observations).actions.some(
        (a) => a.kind === "start_run",
      ),
    ).toBe(false);
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    f.observations.capacity.caps.total = 0;
    expect(
      fixed(failed.next, f.observations).actions.some(
        (a) => a.kind === "start_run",
      ),
    ).toBe(false);
  });
  it("exhaustion flags once", () => {
    const f = failure();
    f.run.attempts = 3;
    const r = fixed(f.state, f.observations);
    expect(r.next.task.failed?.reason).toBe("retries_exhausted");
    expect(r.actions.some((a) => a.kind === "start_run")).toBe(false);
  });
  it("human retry resets budget without reusing action attempt keys", () => {
    const f = failure();
    f.run.attempts = 3;
    const failed = reconcile(f.state, f.observations);
    f.observations.inputs = [command({ type: "retry" })];
    const r = fixed(failed.next, f.observations);
    expect(r.next.task.failed).toBeNull();
    expect(r.actions.find((a) => a.kind === "start_run")).toMatchObject({
      attempt: 4,
      key: `start_run:${f.run.id}#4`,
    });
    expect(r.next.runs[0]?.retryBaseAttempt).toBe(3);
  });
  it("an interactive failure ends as vanished and never automatically launches", () => {
    const f = failure("interactive");
    const r = fixed(f.state, f.observations);
    expect(r.next.runs[0]?.endReason).toBe("vanished");
    expect(r.next.task.attention.reasons).toContain("run_vanished");
    expect(r.actions.some((a) => a.kind === "start_run")).toBe(false);
  });
  it("Claude session epoch changes only when resume is impossible", () => {
    const f = fixture("in_review");
    const run = f.state.runs[2] as Run;
    run.endedAt = now;
    run.endReason = "vanished";
    f.observations.inputs = [command({ type: "retry" })];
    const observation = f.observations.runs[2] as RunObservation;
    observation.resumable = false;
    const r = fixed(f.state, f.observations);
    expect(r.actions.find((a) => a.kind === "start_run")).toMatchObject({
      sessionEpoch: 1,
      sessionId: f.state.config.deriveClaudeSessionId(run.id, 1),
      resume: false,
    });
  });
  it("flags block starts and automatic retry schedules", () => {
    const f = failure();
    f.state.task.blocked = {
      reason: "question",
      detail: "Wait",
      since: now,
      until: null,
      questionId: null,
    };
    f.state.questions = [
      {
        id: "q1" as never,
        taskId: f.run.taskId,
        runId: f.run.id,
        question: "Wait",
        options: [],
        blocking: true,
        askedAt: now,
        answer: null,
        answeredAt: null,
      },
    ];
    const r = fixed(f.state, f.observations);
    expect(
      r.actions.filter(
        (a) =>
          a.kind === "start_run" ||
          (a.kind === "schedule" && a.why === "retry"),
      ),
    ).toEqual([]);
  });
  it("external sessions remain observe-only", () => {
    const f = fixture();
    f.observations.externalSessions = [
      {
        provider: "claude",
        sessionId: "external" as never,
        cwd: makeRun().worktreePath,
        kind: "background",
        active: true,
      },
    ];
    const r = fixed(f.state, f.observations);
    const external = r.next.runs.find((r) => r.origin === "external");
    expect(external).toMatchObject({ sessionId: "external" });
    expect(
      r.actions.some((a) => "runId" in a && a.runId === external?.id),
    ).toBe(false);
  });
});

describe("launch results and persisted outbox", () => {
  it("creates the worktree before constructing runs and unlocks Codex prompts only after recording session identity", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    f.observations.runs = [];
    f.state.worktree = null;
    f.state.task.worktreePath = null;
    const first = fixed(f.state, f.observations);
    const create = first.actions.find((a) => a.kind === "create_worktree");
    if (!create) throw Error("Missing worktree action");
    f.observations.inputs = [
      actionInput(create, {
        path: "/tmp/loom/t1",
        headSha: head,
        baseSha: base,
      }),
    ];
    const created = fixed(first.next, f.observations);
    const start = created.actions.find((a) => a.kind === "start_run");
    if (start?.kind !== "start_run") throw Error("Missing start");
    expect(created.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(created.next.runs[0]?.sessionId).toBeNull();
    f.observations.inputs = [
      actionInput(
        start,
        { sessionId: "session1", codexGeneration: 2, pane: null },
        "started",
      ),
    ];
    f.observations.runs = [
      {
        runId: start.runId,
        resumable: null,
        activityAt: null,
        provider: {
          ok: true,
          at: now,
          value: {
            provider: "codex",
            threadId: "session1" as never,
            generation: 2,
            status: "idle",
            activeFlags: [],
            turns: [],
            lastError: null,
            pendingRequests: [],
            rateLimits: null,
          },
        },
        pane: null,
      },
    ];
    const started = fixed(created.next, f.observations);
    expect(started.next.runs[0]?.sessionId).toBe("session1");
    expect(started.actions.some((a) => a.kind === "send_message")).toBe(true);
  });
  it("Claude ID is derived before launch, and starts carry capacity CAS", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    f.state.task.providers.planner = "claude";
    const r = fixed(f.state, f.observations);
    const id = runId(f.state.task.id, "planner", 0);
    expect(r.actions.find((a) => a.kind === "start_run")).toMatchObject({
      runId: id,
      sessionId: f.state.config.deriveClaudeSessionId(id, 0),
      sessionEpoch: 0,
    });
    expect(r.capacityVersion).toBe(4);
  });
  it("a fatal action records failed and a retryable action gets a suffixed key", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    f.state.worktree = null;
    const first = reconcile(f.state, f.observations);
    const create = first.actions.find((a) => a.kind === "create_worktree");
    if (!create) throw Error("Missing create");
    const fail = {
      ...actionInput(create, {}),
      result: {
        kind: create.kind,
        ok: false,
        error: { code: "retryable", message: "Transient" },
      },
    } as Input;
    f.observations.inputs = [fail];
    const failed = fixed(first.next, f.observations);
    expect(failed.next.task.failed).toBeNull();
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    const retry = fixed(failed.next, f.observations);
    expect(retry.actions.find((a) => a.kind === "create_worktree")?.key).toBe(
      `${create.key}#2`,
    );
    f.observations.inputs = [
      {
        ...fail,
        id: "fatal" as never,
        result: {
          kind: create.kind,
          ok: false,
          error: { code: "fatal", message: "Bad path" },
        },
      } as Input,
    ];
    const fatal = fixed(first.next, f.observations);
    expect(fatal.next.task.failed?.reason).toBe("action_failed");
  });
  it("merge transport success never proves Done", () => {
    const f = fixture("awaiting_approval");
    f.observations.inputs = [command({ type: "approve", headSha: head })];
    const approved = reconcile(f.state, f.observations);
    const merge = approved.actions.find((a) => a.kind === "merge_pr");
    if (!merge) throw Error("Missing merge");
    f.observations.inputs = [actionInput(merge, { state: "merged" })];
    expect(fixed(approved.next, f.observations).next.task.stage).toBe(
      "merging",
    );
  });
});
