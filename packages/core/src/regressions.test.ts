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
        { sessionId: "late", codexGeneration: 1, herdr: null },
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
  it("push precedes PR creation and reviewer launch via durable dependencies", () => {
    const f = fixture();
    f.state.task.prNumber = null;
    f.state.task.reviewRound = 0;
    f.state.runs = f.state.runs.filter((r) => r.role !== "reviewer");
    if (f.observations.github?.ok) f.observations.github.value = null;
    f.observations.inputs = [mcp(submit())];
    const r = fixed(f.state, f.observations);
    const push = r.actions.find((a) => a.kind === "push_branch");
    const open = r.next.outbox.find((a) => a.kind === "open_pr");
    const start = r.next.outbox.find((a) => a.kind === "start_run");
    expect(open?.dependsOn).toContain(push?.key);
    expect(start?.dependsOn).toContain(open?.key);
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
      herdr: null,
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
