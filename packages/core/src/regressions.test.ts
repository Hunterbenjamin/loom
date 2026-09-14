import { describe, expect, it } from "vitest";
import {
  actionInput,
  command,
  finding,
  fixed,
  fixture,
  head,
  mcp,
  now,
  plan,
  run,
  submit,
} from "../test/fixtures.js";
import type { Input, RunObservation } from "./index.js";
import { reconcile } from "./index.js";

describe("reconciliation ordering and recovery regressions", () => {
  it("cancel invalidates queued launches and late results cannot resurrect a run", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    const queued = reconcile(f.state, f.observations);
    const start = queued.actions.find((a) => a.kind === "start_run");
    if (!start) throw Error("Missing start");
    f.observations.inputs = [
      command({ type: "cancel", reason: "Stop" }),
      actionInput(
        start,
        { sessionId: "late", codexGeneration: 1, pane: null },
        "late",
      ),
    ];
    const canceled = fixed(queued.next, f.observations);
    expect(canceled.next.outbox.find((a) => a.key === start.key)?.status).toBe(
      "canceled",
    );
    expect(canceled.next.runs[0]).toMatchObject({
      status: "ended",
      endReason: "canceled",
      sessionId: null,
    });
  });
  it("reopened task can request a previously canceled worktree intent", () => {
    const f = fixture("todo");
    f.state.plan = null;
    f.state.runs = [];
    f.state.worktree = null;
    const queued = reconcile(f.state, f.observations);
    f.observations.inputs = [command({ type: "cancel", reason: "Stop" })];
    const canceled = reconcile(queued.next, f.observations);
    f.observations.inputs = [
      command({ type: "reopen" }, "reopen"),
      command({ type: "move", to: "todo" }, "queue"),
    ];
    const restarted = fixed(canceled.next, f.observations);
    expect(
      restarted.actions.find((a) => a.kind === "create_worktree")?.key,
    ).toBe("create_worktree:t1#2");
  });
  it("a planner releases its capacity slot in the implementation handoff", () => {
    const f = fixture("planning");
    f.state.runs = f.state.runs.filter((r) => r.role === "planner");
    const o = f.observations.runs[0] as RunObservation;
    if (o.provider.ok && o.provider.value?.provider === "codex") {
      o.provider.value.status = "active";
      o.provider.value.turns = [
        {
          id: "turn",
          status: "inProgress",
          error: null,
          userMessageHashes: [],
        },
      ];
    }
    f.observations.capacity.active.codex = 1;
    f.observations.capacity.caps.total = 1;
    f.observations.capacity.caps.codex = 1;
    f.observations.inputs = [
      mcp({ tool: "submit_plan", input: { plan } }, "planner"),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.inputs[0]?.accepted).toBe(true);
    expect(r.actions.some((a) => a.kind === "start_run")).toBe(true);
  });
  it("idle implementer waits for capacity before its fix message", () => {
    const f = fixture("awaiting_approval");
    f.observations.capacity.caps.total = 0;
    f.observations.inputs = [
      command({ type: "request_changes", findings: [finding()] }),
    ];
    const blocked = fixed(f.state, f.observations);
    expect(blocked.next.task.stage).toBe("in_progress");
    expect(blocked.actions.some((a) => a.kind === "send_message")).toBe(false);
    f.observations.capacity.caps.total = 4;
    const ready = fixed(blocked.next, f.observations);
    expect(ready.actions.some((a) => a.kind === "send_message")).toBe(true);
    expect(ready.capacityVersion).toBe(4);
  });
  it("submission pushes, and the reviewer starts only after CI passes on that commit", () => {
    const f = fixture();
    f.state.task.prNumber = null;
    f.state.task.reviewRound = 0;
    f.state.runs = f.state.runs.filter((r) => r.role !== "reviewer");
    if (f.observations.github?.ok) f.observations.github.value = null;
    f.observations.inputs = [mcp(submit())];
    const submitted = fixed(f.state, f.observations);
    expect(submitted.actions.some((a) => a.kind === "push_branch")).toBe(true);
    expect(submitted.next.outbox.some((a) => a.kind === "start_run")).toBe(
      false,
    );
    expect(submitted.next.outbox.some((a) => a.kind === "open_pr")).toBe(false);
    expect(submitted.next.task.stage).toBe("in_progress");
    const green = {
      ...f.observations,
      inputs: [],
      ci: {
        ok: true as const,
        at: now,
        value: {
          headSha: head,
          conclusion: "success" as const,
          checks: [],
          observedAt: now,
        },
      },
    };
    const reviewing = fixed(submitted.next, green);
    expect(reviewing.next.task.stage).toBe("in_review");
    expect(reviewing.next.outbox.some((a) => a.kind === "start_run")).toBe(
      true,
    );
    // The PR still opens only once review converges.
    expect(reviewing.next.outbox.some((a) => a.kind === "open_pr")).toBe(false);
  });
  it("later starts remain behind a pending disable-auto-merge action", () => {
    const f = fixture("merging");
    if (f.observations.github?.ok && f.observations.github.value) {
      f.observations.github.value.headSha = "c".repeat(40) as never;
      f.observations.github.value.autoMergeEnabled = true;
    }
    f.observations.capacity.caps.total = 0;
    const moved = reconcile(f.state, f.observations);
    const disarm = moved.actions.find((a) => a.kind === "disable_auto_merge");
    f.observations.capacity.caps.total = 4;
    const ready = fixed(moved.next, f.observations);
    expect(
      ready.next.outbox.find((a) => a.kind === "start_run")?.dependsOn,
    ).toContain(disarm?.key);
  });
  it("provider recovery cancels a scheduled retry", () => {
    const f = fixture("planning");
    const r = f.state.runs[0];
    if (r) {
      r.retryAt = now;
      r.status = "failed";
    }
    expect(
      fixed(f.state, f.observations).actions.some(
        (a) => a.kind === "start_run",
      ),
    ).toBe(false);
  });
  it("unknown provider prevents automatic retry even at its deadline", () => {
    const f = fixture("planning");
    const r = f.state.runs[0];
    if (!r) throw Error("Missing run");
    r.retryAt = now;
    r.status = "failed";
    f.observations.runs[0] = {
      runId: r.id,
      resumable: null,
      activityAt: null,
      provider: { ok: false, at: now, reason: "Disconnected" },
      pane: null,
    };
    expect(
      fixed(f.state, f.observations).actions.some(
        (a) => a.kind === "start_run",
      ),
    ).toBe(false);
  });
  it("findings changes update the projected task artifact once", () => {
    const f = fixture();
    f.state.findings = [finding()];
    const initial = reconcile(f.state, f.observations);
    f.observations.inputs = [
      mcp({
        tool: "resolve_finding",
        input: {
          findingId: finding().id,
          resolution: "fixed",
          note: "Fixed",
          commitSha: head,
        },
      }),
    ];
    const r = fixed(initial.next, f.observations);
    expect(r.next.artifactContents.findings).toMatchObject([
      { status: "addressed" },
    ]);
    expect(r.next.artifacts.find((a) => a.kind === "findings")?.version).toBe(
      2,
    );
  });
  it("test records retain run, time, and commit ownership metadata", () => {
    const f = fixture();
    f.observations.inputs = [
      mcp({
        tool: "report_progress",
        input: {
          summary: "Verified",
          stepIndex: 0,
          decisions: [],
          testResults: [
            { command: "pnpm test", outcome: "passed", summary: "Pass" },
          ],
        },
      }),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.next.progress?.summary).toBe("Verified");
    expect(r.next.artifactContents.test_results).toMatchObject([
      { headSha: head, runId: run().id, ranAt: now },
    ]);
  });
  it("failed transport actions retry under suffixed keys without marking delivered", () => {
    const f = fixture();
    f.observations.inputs = [
      command({ type: "send_message", runId: run().id, text: "Hello" }),
    ];
    const queued = reconcile(f.state, f.observations);
    const action = queued.actions.find((a) => a.kind === "send_message");
    if (!action) throw Error("Missing send");
    f.observations.inputs = [
      {
        ...actionInput(action, {}),
        result: {
          kind: "send_message",
          ok: false,
          error: { code: "retryable", message: "Temporary" },
        },
      } as Input,
    ];
    const failed = fixed(queued.next, f.observations);
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    const retry = fixed(failed.next, f.observations);
    expect(retry.actions.find((a) => a.kind === "send_message")?.key).toBe(
      `${action.key}#2`,
    );
    expect(retry.next.messages[0]?.status).toBe("pending");
  });
});

it("a precondition failure observed while GitHub is unavailable is resolved after a fresh read", () => {
  const f = fixture("awaiting_approval");
  f.observations.inputs = [command({ type: "approve", headSha: head })];
  const approved = reconcile(f.state, f.observations);
  const merge = approved.actions.find((a) => a.kind === "merge_pr");
  if (!merge) throw Error("Missing merge");
  const fresh = f.observations.github;
  f.observations.github = { ok: false, at: now, reason: "Offline" };
  f.observations.inputs = [
    {
      ...actionInput(merge, {}),
      result: {
        kind: "merge_pr",
        ok: false,
        error: { code: "precondition", message: "Not mergeable" },
      },
    } as Input,
  ];
  const unknown = fixed(approved.next, f.observations);
  expect(unknown.next.task.stage).toBe("merging");
  f.observations.github = fresh;
  const recovered = fixed(unknown.next, f.observations);
  expect(recovered.next.task.stage).toBe("awaiting_approval");
});

it("answer_provider_request action does not include command-only fields like type", () => {
  const f = fixture();
  const r = f.state.runs[1];
  if (!r) throw Error("Missing run");
  const o = f.observations.runs[1];
  if (!o?.provider.ok || o.provider.value?.provider !== "codex") {
    throw Error("Missing Codex provider");
  }
  o.provider.value.generation = 2;
  o.provider.value.pendingRequests = [
    {
      requestId: "request-1",
      kind: "command_approval",
      isBlocking: true,
      summary: "Run tests",
      receivedAt: now,
    },
  ];
  f.observations.inputs = [
    command({
      type: "answer_provider_request",
      runId: r.id,
      requestId: "request-1",
      generation: 2,
      decision: "accept",
      answers: null,
    }),
  ];
  const r1 = fixed(f.state, f.observations);
  const action = r1.actions.find((a) => a.kind === "answer_provider_request");
  if (!action) throw Error("Missing answer_provider_request action");
  // Verify the action has the correct fields and no 'type' field
  expect(action).toMatchObject({
    kind: "answer_provider_request",
    runId: r.id,
    requestId: "request-1",
    generation: 2,
    decision: "accept",
    answers: null,
  });
  // Make sure 'type' field is not present in the action
  expect("type" in action).toBe(false);
  // Verify the outbox entry matches the action
  const entry = r1.next.outbox.find(
    (row) => row.kind === "answer_provider_request",
  );
  if (!entry) throw Error("Missing outbox entry");
  if (!entry.action) throw Error("Missing action in outbox");
  expect(entry.action).toEqual(action);
});
