import { describe, expect, it } from "vitest";
import { command, fixed, fixture, mcp, now } from "../test/fixtures.js";
import type { AttentionReason, Run, RunObservation } from "./index.js";
import { reconcile } from "./index.js";

describe("flags derive and clear from authoritative evidence", () => {
  it("dependencies clear when every blocker merges", () => {
    const f = fixture("todo");
    f.state.task.blockedBy = ["dependency" as never];
    const blocked = reconcile(f.state, f.observations);
    expect(blocked.next.task.blocked?.reason).toBe("dependencies");
    expect(blocked.next.task.attention.reasons).not.toContain("blocked");
    f.observations.dependencies = [
      { taskId: "dependency" as never, stage: "done", merged: true },
    ];
    expect(fixed(blocked.next, f.observations).next.task.stage).toBe(
      "in_progress",
    );
  });
  it("blocking questions clear with answers, and answers quote the question ID", () => {
    const f = fixture();
    f.observations.inputs = [
      mcp({
        tool: "ask_human",
        input: { question: "Which path?", options: [], blocking: true },
        questionId: "q1" as never,
      }),
    ];
    const asked = fixed(f.state, f.observations);
    expect(asked.next.task.blocked).toMatchObject({
      reason: "question",
      questionId: "q1",
    });
    f.observations.inputs = [
      command(
        { type: "answer_question", questionId: "q1" as never, answer: "src" },
        "answer",
      ),
    ];
    const answered = fixed(asked.next, f.observations);
    expect(answered.next.task.blocked).toBeNull();
    expect(answered.next.questions[0]?.answer).toBe("src");
    expect(answered.next.messages[0]?.text).toContain("q1");
  });
  it("one answer does not clear another blocking question", () => {
    const f = fixture();
    f.observations.inputs = ["q1", "q2"].map((id) =>
      mcp(
        {
          tool: "ask_human",
          input: { question: id, options: [], blocking: true },
          questionId: id as never,
        },
        "implementer",
        id,
      ),
    );
    const asked = reconcile(f.state, f.observations);
    f.observations.inputs = [
      command(
        { type: "answer_question", questionId: "q1" as never, answer: "Yes" },
        "answer",
      ),
    ];
    expect(fixed(asked.next, f.observations).next.task.blocked).toMatchObject({
      reason: "question",
      questionId: "q2",
    });
  });
  it("provider cooldown needs elapsed reset plus a fresh allowed snapshot", () => {
    const f = fixture();
    const o = f.observations.runs[1] as RunObservation;
    const until = "2026-09-12T00:01:00.000Z" as typeof now;
    if (o.provider.ok && o.provider.value?.provider === "codex")
      o.provider.value.rateLimits = { usageAllowed: false, resetsAt: until };
    const blocked = fixed(f.state, f.observations);
    expect(blocked.next.task.blocked).toMatchObject({
      reason: "provider_cooling_down",
      until,
    });
    expect(blocked.next.task.attention.reasons).not.toContain("blocked");
    f.observations.now = until;
    o.provider = { ok: false, at: until, reason: "Offline" };
    const unavailable = fixed(blocked.next, f.observations);
    expect(unavailable.next.task.blocked?.reason).toBe("provider_cooling_down");
    const fresh = fixture().observations.runs[1] as RunObservation;
    f.observations.runs[1] = fresh;
    expect(
      fixed(unavailable.next, f.observations).next.task.blocked,
    ).toBeNull();
  });
  it("closed PR blocks until reopened or canceled", () => {
    const f = fixture();
    if (f.observations.github?.ok && f.observations.github.value)
      f.observations.github.value.state = "closed";
    const closed = fixed(f.state, f.observations);
    expect(closed.next.task.blocked?.reason).toBe("pr_closed");
    if (f.observations.github?.ok && f.observations.github.value)
      f.observations.github.value.state = "open";
    expect(fixed(closed.next, f.observations).next.task.blocked).toBeNull();
  });
  it("trust dialog clears only after SessionStart and busy/idle status", () => {
    const f = fixture();
    const run = f.state.runs[2] as Run;
    run.mode = "interactive";
    run.seenAt = null;
    const o = f.observations.runs[2] as RunObservation;
    if (o.provider.ok && o.provider.value?.provider === "claude") {
      o.provider.value.agentsEntry = null;
      o.provider.value.hooks.sessionStart = null;
    }
    o.herdr = {
      ok: true,
      at: now,
      value: {
        name: "agent",
        paneId: "p1",
        cwd: run.worktreePath,
        state: "blocked",
        agentSessionId: null,
      },
    };
    const blocked = fixed(f.state, f.observations);
    expect(blocked.next.task.blocked?.reason).toBe("trust_dialog");
    const fresh = fixture().observations.runs[2] as RunObservation;
    f.observations.runs[2] = fresh;
    expect(fixed(blocked.next, f.observations).next.task.blocked).toBeNull();
  });
  it("non-retryable provider error flags directly", () => {
    const f = fixture("planning");
    const o = f.observations.runs[0] as RunObservation;
    if (o.provider.ok && o.provider.value?.provider === "codex") {
      o.provider.value.turns = [
        {
          id: "failed",
          status: "failed",
          error: {
            kind: "other",
            willRetry: false,
            message: "Unsupported model",
          },
          userMessageHashes: [],
        },
      ];
    }
    expect(fixed(f.state, f.observations).next.task.failed?.reason).toBe(
      "non_retryable_error",
    );
  });
});

describe("every attention reason", () => {
  const cases: [AttentionReason, (f: ReturnType<typeof fixture>) => void][] = [
    [
      "plan_needs_approval",
      (f) => {
        f.state.task.stage = "plan_approval";
      },
    ],
    [
      "needs_approval",
      (f) => {
        f.state.task.stage = "awaiting_approval";
      },
    ],
    [
      "question",
      (f) => {
        f.observations.inputs = [
          mcp({
            tool: "ask_human",
            questionId: "q1" as never,
            input: { question: "Help?", options: [], blocking: false },
          }),
        ];
      },
    ],
    [
      "provider_permission",
      (f) => {
        const o = f.observations.runs[1];
        if (o?.provider.ok && o.provider.value?.provider === "codex") {
          o.provider.value.status = "active";
          o.provider.value.activeFlags = ["waitingOnApproval"];
        }
      },
    ],
    [
      "provider_input",
      (f) => {
        const o = f.observations.runs[1];
        if (o?.provider.ok && o.provider.value?.provider === "codex") {
          o.provider.value.status = "active";
          o.provider.value.activeFlags = ["waitingOnUserInput"];
        }
      },
    ],
    [
      "provider_dialog",
      (f) => {
        const run = f.state.runs[2] as Run;
        run.mode = "interactive";
        run.seenAt = null;
        const o = f.observations.runs[2] as RunObservation;
        if (o.provider.ok && o.provider.value?.provider === "claude") {
          o.provider.value.agentsEntry = null;
          o.provider.value.hooks.sessionStart = null;
        }
        o.herdr = {
          ok: true,
          at: now,
          value: {
            name: "agent",
            paneId: "p",
            cwd: run.worktreePath,
            state: "blocked",
            agentSessionId: null,
          },
        };
      },
    ],
    [
      "blocked",
      (f) => {
        f.state.task.blocked = {
          reason: "review_round_cap",
          since: now,
          detail: "Cap",
          until: null,
          questionId: null,
        };
      },
    ],
    [
      "failed",
      (f) => {
        f.state.task.failed = {
          reason: "action_failed",
          since: now,
          detail: "Failure",
          runId: null,
        };
      },
    ],
    [
      "run_vanished",
      (f) => {
        const run = f.state.runs[1] as Run;
        run.endedAt = now;
        run.endReason = "vanished";
      },
    ],
    [
      "stalled",
      (f) => {
        const o = f.observations.runs[1];
        if (o?.provider.ok && o.provider.value?.provider === "codex") {
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
        f.observations.now = "2026-09-12T00:16:00.000Z" as typeof now;
      },
    ],
    [
      "status_unknown",
      (f) => {
        const run = f.state.runs[1] as Run;
        run.unknownSince = now;
        f.observations.runs[1] = {
          runId: run.id,
          resumable: null,
          activityAt: null,
          provider: { ok: false, at: now, reason: "Offline" },
          herdr: null,
        };
        f.observations.now = "2026-09-12T00:01:01.000Z" as typeof now;
      },
    ],
    [
      "over_budget",
      (f) => {
        f.state.task.budgetMinutes = 1;
        f.observations.now = "2026-09-12T00:02:00.000Z" as typeof now;
      },
    ],
  ];
  for (const [reason, setup] of cases)
    it(reason, () => {
      const f = fixture();
      setup(f);
      const r = fixed(f.state, f.observations);
      expect(r.next.task.attention.reasons).toContain(reason);
      expect(r.next.task.attention.since).toBe(f.observations.now);
    });
  it("unchanged reasons preserve their since timestamp", () => {
    const f = fixture("plan_approval");
    const r = reconcile(f.state, f.observations);
    f.observations.now = "2026-09-12T00:00:01.000Z" as typeof now;
    expect(fixed(r.next, f.observations).next.task.attention.since).toBe(now);
  });
  it("budget excludes parked time and accumulates active stages", () => {
    const f = fixture("backlog");
    f.state.task.budgetMinutes = 1;
    f.observations.now = "2026-09-12T01:00:00.000Z" as typeof now;
    const parked = reconcile(f.state, f.observations);
    expect(parked.next.activeElapsedMs ?? 0).toBe(0);
    f.observations.inputs = [command({ type: "move", to: "todo" })];
    const active = reconcile(parked.next, f.observations);
    f.observations.now = "2026-09-12T01:02:00.000Z" as typeof now;
    expect(
      fixed(active.next, f.observations).next.task.attention.reasons,
    ).toContain("over_budget");
  });
});
