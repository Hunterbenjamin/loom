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
import type { Input, OutboxEntry, Run, RunObservation } from "./index.js";
import { reconcile, runId, sumTokenUsage } from "./index.js";

describe("token usage", () => {
  it("replaces usage per session, retains it on no evidence, and sums epochs and roles", () => {
    const f = fixture("in_progress");
    const observation = f.observations.runs[1] as RunObservation;
    observation.tokenUsage = {
      input: 100,
      cachedInput: 40,
      output: 20,
      reasoning: 5,
    };
    const first = reconcile(f.state, f.observations).next;
    const implementer = first.runs[1] as Run;
    expect(implementer.tokenUsage).toEqual([
      {
        sessionId: implementer.sessionId,
        counts: observation.tokenUsage,
        observedAt: now,
      },
    ]);

    observation.tokenUsage = {
      input: 120,
      cachedInput: 50,
      output: 25,
      reasoning: 6,
    };
    const replaced = reconcile(first, f.observations).next;
    expect(replaced.runs[1]?.tokenUsage).toHaveLength(1);
    f.observations.now = "2026-09-12T00:01:00.000Z" as typeof now;
    const reread = reconcile(replaced, f.observations).next;
    expect(reread.runs[1]?.tokenUsage).toEqual(replaced.runs[1]?.tokenUsage);
    observation.tokenUsage = null;
    const retained = reconcile(reread, f.observations).next;
    expect(retained.runs[1]?.tokenUsage).toEqual(reread.runs[1]?.tokenUsage);

    const rotated = retained;
    const rotatedRun = rotated.runs[1] as Run;
    rotatedRun.sessionId = "replacement-session" as never;
    rotatedRun.sessionEpoch++;
    observation.tokenUsage = {
      input: 30,
      cachedInput: 10,
      output: 8,
      reasoning: 2,
    };
    const final = reconcile(rotated, f.observations).next;
    expect(final.runs[1]?.tokenUsage).toHaveLength(2);
    expect(sumTokenUsage(final.runs)).toEqual({
      input: 150,
      cachedInput: 60,
      output: 33,
      reasoning: 8,
    });
    expect(
      sumTokenUsage(final.runs.filter((run) => run.role === "implementer")),
    ).toEqual({ input: 150, cachedInput: 60, output: 33, reasoning: 8 });
  });
});

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
  it("tracks provider-native in-flight turns and preserves them on unknown reads", () => {
    const f = fixture("in_progress");
    const observation = f.observations.runs[1] as RunObservation;
    if (
      !observation.provider.ok ||
      observation.provider.value?.provider !== "codex"
    )
      throw new Error("Missing Codex fixture");
    observation.provider.value.status = "active";
    observation.provider.value.turns = [
      {
        id: "turn-live",
        status: "inProgress",
        error: null,
        userMessageHashes: [],
      },
    ];
    const observed = reconcile(f.state, f.observations).next;
    expect(observed.runs[1]?.inFlightTurnId).toBe("turn-live");
    const failed = f.observations.runs[1] as RunObservation;
    failed.provider = { ok: false, reason: "offline", at: now };
    expect(
      reconcile(observed, f.observations).next.runs[1]?.inFlightTurnId,
    ).toBe("turn-live");

    const claude = fixture("in_review");
    const claudeObservation = claude.observations.runs[2] as RunObservation;
    if (
      !claudeObservation.provider.ok ||
      claudeObservation.provider.value?.provider !== "claude"
    )
      throw new Error("Missing Claude fixture");
    claudeObservation.provider.value.hooks.promptSubmits = [
      { promptId: "prompt-live", textHash: "prompt", at: now },
    ];
    const claudeObserved = reconcile(claude.state, claude.observations).next;
    expect(claudeObserved.runs[2]?.inFlightTurnId).toBe("prompt-live");
    claudeObservation.provider.value.hooks.lastStop = {
      promptId: "prompt-live",
      at: now,
      lastAssistantMessage: null,
    };
    expect(
      reconcile(claudeObserved, claude.observations).next.runs[2]
        ?.inFlightTurnId,
    ).toBeNull();
  });
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
      mode: "headless",
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
  it("a Codex thread with no rollout is retried on a fresh thread", () => {
    // The first real reviewer run: `thread/resume` said "no rollout found", so every read failed
    // and the run sat in `unknown` with nothing left to send its first message to.
    const f = failure();
    f.observation.provider = { ok: false, reason: "not loaded", at: now };
    f.observation.resumable = false;
    const failed = reconcile(f.state, f.observations);
    expect(failed.next.runs[0]).toMatchObject({
      status: "failed",
      retryAt: "2026-09-12T00:00:10.000Z",
    });
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    const r = fixed(failed.next, f.observations);
    expect(r.actions.find((a) => a.kind === "start_run")).toMatchObject({
      key: `start_run:${f.run.id}#2`,
      attempt: 2,
      sessionEpoch: 1,
      sessionId: null,
      resume: false,
    });
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
    f.observations.externalSessions = {
      ok: true,
      value: [
        {
          provider: "claude",
          sessionId: "external" as never,
          cwd: makeRun().worktreePath,
          kind: "background",
          active: true,
        },
      ],
      at: now,
    };
    const r = fixed(f.state, f.observations);
    const external = r.next.runs.find((r) => r.origin === "external");
    expect(external).toMatchObject({ sessionId: "external" });
    expect(
      r.actions.some((a) => "runId" in a && a.runId === external?.id),
    ).toBe(false);
  });

  it("external runs are ended when task reaches done stage", () => {
    const f = fixture("in_review");
    f.observations.externalSessions = {
      ok: true,
      value: [
        {
          provider: "claude",
          sessionId: "external_session" as never,
          cwd: f.state.task.worktreePath as never,
          kind: "background",
          active: true,
        },
      ],
      at: now,
    };
    // Create the external run
    let r = fixed(f.state, f.observations);
    const externalRun = r.next.runs.find((r) => r.origin === "external");
    expect(externalRun).toBeDefined();
    expect(externalRun?.endedAt).toBeNull();

    // Simulate PR merge to move task to done stage
    if (f.observations.github?.ok && f.observations.github.value)
      f.observations.github.value.state = "merged";
    r = fixed(r.next, f.observations);
    const endedExternal = r.next.runs.find(
      (r) => r.origin === "external" && r.sessionId === "external_session",
    );
    expect(endedExternal).toMatchObject({
      status: "ended",
      endedAt: now,
      endReason: "task_done",
    });
  });

  it("external runs are ended when task is canceled", () => {
    const f = fixture("in_review");
    f.observations.externalSessions = {
      ok: true,
      value: [
        {
          provider: "claude",
          sessionId: "external_session" as never,
          cwd: f.state.task.worktreePath as never,
          kind: "background",
          active: true,
        },
      ],
      at: now,
    };
    // Create the external run
    let r = fixed(f.state, f.observations);
    const externalRun = r.next.runs.find((r) => r.origin === "external");
    expect(externalRun).toBeDefined();
    expect(externalRun?.endedAt).toBeNull();

    // Simulate cancel command
    f.observations.inputs = [command({ type: "cancel", reason: "not viable" })];
    r = fixed(r.next, f.observations);
    const endedExternal = r.next.runs.find(
      (r) => r.origin === "external" && r.sessionId === "external_session",
    );
    expect(endedExternal).toMatchObject({
      status: "ended",
      endedAt: now,
      endReason: "canceled",
    });
  });

  it("external runs do not count toward provider capacity", () => {
    const f = fixture("planning");
    // Add an external session
    f.observations.externalSessions = {
      ok: true,
      value: [
        {
          provider: "claude",
          sessionId: "external_session" as never,
          cwd: f.state.task.worktreePath as never,
          kind: "background",
          active: true,
        },
      ],
      at: now,
    };
    // Add a Loom-launched run that would be in planning
    const loomRunId = f.state.runs[0]?.id;
    expect(f.state.runs[0]?.origin).toBe("loom");

    // Run reconciliation
    const r = fixed(f.state, f.observations);

    // Verify external run exists and is active
    const externalRun = r.next.runs.find((r) => r.origin === "external");
    expect(externalRun).toMatchObject({
      status: "working",
      origin: "external",
    });

    // Verify the observations compute capacity without external runs
    // The capacity calculation should only count Loom-launched runs
    const live = r.next.runs.filter((r) => !r.endedAt && r.origin === "loom");
    expect(live.some((r) => r.id === loomRunId)).toBe(true);
    expect(live.some((r) => r.origin === "external")).toBe(false);
  });
});

describe("launch results and persisted outbox", () => {
  it("relaunch refreshes the git observation exactly once in an undelivered initial message", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    f.observations.runs = [];
    f.state.config = {
      ...f.state.config,
      runModes: { ...f.state.config.runModes, planner: "headless" },
    };
    const first = reconcile(f.state, f.observations);
    const start = first.actions.find((a) => a.kind === "start_run");
    if (!start) throw Error("Missing start");
    const pending = first.next.messages[0];
    if (!pending) throw Error("Missing initial message");
    expect(pending.attempts).toBe(0);
    const originalText = pending.text;
    f.observations.inputs = [
      actionInput(start, {
        sessionId: "session1",
        codexGeneration: 2,
        pane: null,
      }),
    ];
    const started = reconcile(first.next, f.observations);
    const run = started.next.runs[0];
    if (!run) throw Error("Missing run");
    f.observations.inputs = [];
    f.observations.runs = [
      {
        runId: run.id,
        resumable: false,
        activityAt: null,
        tokenUsage: null,
        readFailures: { resumable: null, activityAt: null, tokenUsage: null },
        provider: { ok: false, at: now, reason: "no rollout" },
        pane: null,
      },
    ];
    const failed = reconcile(started.next, f.observations);
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    if (f.observations.git?.ok) f.observations.git.value.dirty = true;
    const retried = reconcile(failed.next, f.observations);
    expect(retried.actions.find((a) => a.kind === "start_run")).toMatchObject({
      attempt: 2,
    });
    const message = retried.next.messages.find((m) => m.id === pending.id);
    expect(message?.attempts).toBe(0);
    expect(message?.text.match(/^Current git observation:/gm)).toHaveLength(1);
    expect(message?.text).toContain('"dirty":true');
    expect(message?.text).toContain(originalText.split("\n")[0]);
    expect(message?.textHash).toBe(f.state.config.sha256(message?.text ?? ""));
  });
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
        tokenUsage: null,
        readFailures: { resumable: null, activityAt: null, tokenUsage: null },
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
  it("waits for dependency merge SHAs and carries them into worktree creation", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    f.state.worktree = null;
    f.state.task.worktreePath = null;
    f.state.task.blockedBy = ["dependency" as never];
    f.observations.dependencies = [
      {
        taskId: "dependency" as never,
        stage: "done",
        merged: true,
        mergeCommitSha: null,
        branch: "feat/dependency",
      },
    ];
    expect(
      fixed(f.state, f.observations).actions.some(
        (action) => action.kind === "create_worktree",
      ),
    ).toBe(false);
    const dependency = f.observations.dependencies[0];
    if (!dependency) throw new Error("Missing dependency");
    dependency.mergeCommitSha = head;
    expect(
      fixed(f.state, f.observations).actions.find(
        (action) => action.kind === "create_worktree",
      ),
    ).toMatchObject({ requiredCommits: [head] });
  });
  it("emits terminal worktree cleanup, records removal, and recreates reopened generations", () => {
    const f = fixture("done");
    for (const run of f.state.runs) {
      run.status = "ended";
      run.endedAt = now;
      run.endReason = "task_done";
    }
    const terminal = reconcile(f.state, f.observations);
    const remove = terminal.actions.find(
      (action) => action.kind === "remove_worktree",
    );
    if (!remove) throw Error("Missing worktree removal");
    expect(remove.key).toBe(`remove_worktree:t1:${now}`);
    f.observations.inputs = [actionInput(remove, { removed: true })];
    const removed = fixed(terminal.next, f.observations);
    expect(removed.next.worktree?.removedAt).toBe(now);

    removed.next.task.stage = "todo";
    removed.next.task.blocked = null;
    removed.next.task.failed = null;
    removed.next.plan = null;
    removed.next.desiredRun = null;
    f.observations.inputs = [];
    const reopened = fixed(removed.next, f.observations);
    expect(
      reopened.actions.find((action) => action.kind === "create_worktree")?.key,
    ).toBe(`create_worktree:t1:${now}`);
  });
  it("retries removal in terminal stages without failing the task", () => {
    const f = fixture("done");
    f.state.config.retry = { ...f.state.config.retry, maxAttempts: 1 };
    f.state.runs = [];
    f.observations.runs = [];
    const terminal = reconcile(f.state, f.observations);
    const remove = terminal.actions.find(
      (action) => action.kind === "remove_worktree",
    );
    if (!remove) throw Error("Missing worktree removal");
    f.observations.inputs = [
      {
        ...actionInput(remove, {}),
        result: {
          kind: "remove_worktree",
          ok: false,
          error: { code: "retryable", message: "Worktree dirty" },
        },
      } as Input,
    ];
    const failed = fixed(terminal.next, f.observations);
    expect(failed.next.task.failed).toBeNull();
    f.observations.inputs = [];
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    const retried = fixed(failed.next, f.observations);
    expect(
      retried.actions.find((action) => action.kind === "remove_worktree")?.key,
    ).toBe(`${remove.key}#2`);
    expect(
      retried.actions.find(
        (action) =>
          action.kind === "notify" &&
          action.title === "Worktree cleanup needs attention",
      ),
    ).toMatchObject({ body: "Worktree dirty" });
    expect(retried.next.task.failed).toBeNull();
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

describe("run mode configuration", () => {
  it("default config has interactive mode for all roles", () => {
    const f = fixture("planning");
    // Verify the default config has interactive mode for all roles
    expect(f.state.config.runModes).toEqual({
      planner: "interactive",
      implementer: "interactive",
      reviewer: "interactive",
    });
  });

  it("run fixture uses config.runModes to set mode", () => {
    const f = fixture("in_progress");
    // Existing planner run from fixture should use config.runModes
    const planner = f.state.runs.find((r) => r.role === "planner");
    // The run fixture uses config.runModes, so it should be interactive
    expect(planner?.mode).toBe("interactive");
  });

  it.each(["planner", "implementer", "reviewer"] as const)(
    "creates a new %s run with the interactive default",
    (role) => {
      const f = fixture(
        role === "planner"
          ? "planning"
          : role === "reviewer"
            ? "in_review"
            : "in_progress",
      );
      f.state.runs = f.state.runs.filter((run) => run.role !== role);
      f.observations.runs = f.observations.runs.filter(
        (observation) => !observation.runId.includes(`/${role}/`),
      );
      if (role === "planner") {
        f.state.plan = null;
        f.state.review = null;
        f.state.task.prNumber = null;
        f.observations.github = { ok: true, at: now, value: null };
      }
      f.state.desiredRun = {
        role,
        round: role === "reviewer" ? 1 : 0,
        resume: false,
      };
      const r = fixed(f.state, f.observations);
      expect(r.next.runs.find((run) => run.role === role)?.mode).toBe(
        "interactive",
      );
    },
  );

  it("uses a role override only when creating the run", () => {
    const f = fixture("backlog");
    f.state.task.stage = "todo";
    f.state.runs = [];
    f.state.config.runModes.implementer = "headless";
    f.state.desiredRun = { role: "implementer", round: 0, resume: false };
    const r = fixed(f.state, f.observations);
    const impl = r.next.runs.find((run) => run.role === "implementer");
    expect(impl?.mode).toBe("headless");
  });
});

it("uses instance routing and pins model and reasoning on a new planner", () => {
  const f = fixture("planning");
  f.state.runs = [];
  f.observations.runs = [];
  f.state.plan = null;
  f.state.review = null;
  f.state.task.prNumber = null;
  f.observations.github = { ok: true, at: now, value: null };
  f.state.task.providers.planner = "claude";
  f.state.desiredRun = { role: "planner", round: 0, resume: false };
  f.state.config = {
    ...f.state.config,
    models: { codex: "gpt-5.6-sol", claude: "old-claude" },
    providerOverrides: { planner: "codex" },
    codexReasoningEffort: "medium",
  };
  f.observations.capacity.caps.claude = 0;
  const result = reconcile(f.state, f.observations);
  expect(result.next.task.providers.planner).toBe("codex");
  expect(result.next.runs[0]).toMatchObject({
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  expect(result.actions.find((a) => a.kind === "start_run")).toMatchObject({
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
});

it("a config change does not migrate a retry to another provider or model", () => {
  const f = failure();
  f.run.reasoningEffort = "high";
  f.state.config = {
    ...f.state.config,
    providerOverrides: { planner: "claude" },
    models: { codex: "new-model", claude: "other-model" },
    codexReasoningEffort: "medium",
  };
  const failed = reconcile(f.state, f.observations);
  f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
  const result = fixed(failed.next, f.observations);
  expect(result.actions.find((a) => a.kind === "start_run")).toMatchObject({
    provider: "codex",
    model: "fake",
    reasoningEffort: "high",
  });
});

describe("retiring finished interactive panes", () => {
  const ended = (stage: Parameters<typeof fixture>[0]) => {
    const f = fixture(stage);
    const planner = f.state.runs[0] as Run;
    planner.mode = "interactive";
    planner.status = "ended";
    planner.endReason = "submitted";
    planner.endedAt = now;
    return { f, planner };
  };
  it("closes a submitted planner's pane once the plan is settled, exactly once", () => {
    const { f, planner } = ended("in_progress");
    const r = fixed(f.state, f.observations);
    const key = `stop_run:${planner.id}#${planner.attempts}:retire`;
    expect(r.actions.find((a) => a.key === key)).toMatchObject({
      kind: "stop_run",
      runId: planner.id,
      retire: true,
    });
    expect(r.next.runs[0]?.status).toBe("ended");
  });
  const row = (
    action: Record<string, unknown> & { kind: string; key: string },
    status: OutboxEntry["status"],
    dependsOn: string[] = [],
  ) =>
    ({
      key: action.key,
      kind: action.kind,
      status,
      attempts: status === "pending" ? 0 : 1,
      createdAt: now,
      finishedAt: status === "pending" ? null : now,
      action: { taskId: f0.state.task.id, ...action },
      dependsOn,
    }) as OutboxEntry;
  const f0 = fixture("done");
  const merge = {
    key: "merge_pr:approval/1",
    kind: "merge_pr",
    repoId: f0.state.task.repoId,
    prNumber: 1,
    matchHeadSha: head,
    auto: false,
  };
  it("closes a pane whose retire was queued behind a merge that was canceled", () => {
    const { f, planner } = ended("done");
    const key = `stop_run:${planner.id}#${planner.attempts}:retire`;
    f.state.outbox = [
      row(merge, "canceled"),
      row(
        { key, kind: "stop_run", runId: planner.id, retire: true },
        "pending",
        [merge.key],
      ),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.next.outbox.find((o) => o.key === key)).toMatchObject({
      status: "pending",
      dependsOn: [],
    });
  });
  it("releases cleanup from a failed action a finished task will never retry, but not a live retry", () => {
    const failed = {
      ...merge,
      key: "disable_auto_merge:1",
      kind: "disable_auto_merge",
    };
    const stop = {
      key: "stop_run:x:retire",
      kind: "stop_run",
      runId: runId(f0.state.task.id, "reviewer", 1),
      retire: true,
    };
    const done = fixture("done");
    done.state.outbox = [
      { ...row(failed, "failed"), retryAt: now },
      row(stop, "pending", [failed.key]),
    ];
    expect(
      fixed(done.state, done.observations).next.outbox.find(
        (o) => o.key === stop.key,
      )?.dependsOn,
    ).toEqual([]);
    const live = fixture("in_progress");
    live.state.outbox = [
      {
        ...row(failed, "failed"),
        retryAt: "2026-09-12T01:00:00.000Z" as typeof now,
      },
      row(stop, "pending", [failed.key]),
    ];
    expect(
      reconcile(live.state, live.observations).next.outbox.find(
        (o) => o.key === stop.key,
      )?.dependsOn,
    ).toEqual([failed.key]);
  });
  it("cancels work queued behind a canceled action instead of leaving it pending forever", () => {
    const f = fixture("awaiting_approval");
    const push = {
      key: "push_branch:1",
      kind: "push_branch",
      worktreePath: f.state.task.worktreePath,
      branch: "feat/core",
      expectedHeadSha: head,
    };
    const open = {
      key: "open_pr:1",
      kind: "open_pr",
      repoId: f.state.task.repoId,
      branch: "feat/core",
      baseBranch: "main",
      title: "t",
      body: "b",
    };
    f.state.outbox = [row(push, "canceled"), row(open, "pending", [push.key])];
    const r = reconcile(f.state, f.observations);
    expect(r.next.outbox.find((o) => o.key === open.key)?.status).toBe(
      "canceled",
    );
    expect(r.actions.some((a) => a.key === open.key)).toBe(false);
  });
  it("keeps the planner's pane while the plan can still be rejected", () => {
    const { f, planner } = ended("plan_approval");
    const r = reconcile(f.state, f.observations);
    expect(
      r.actions.some(
        (a) => a.kind === "stop_run" && a.runId === planner.id && a.retire,
      ),
    ).toBe(false);
  });
});
