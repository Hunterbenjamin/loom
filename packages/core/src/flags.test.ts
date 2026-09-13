import { describe, expect, it } from "vitest";
import {
  command,
  fixed,
  fixture,
  mcp,
  now,
  plan,
  reviewCall,
  submit,
} from "../test/fixtures.js";
import type { AttentionReason, Run, RunObservation, Stage } from "./index.js";
import { deriveAttention, reconcile } from "./index.js";

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

describe("idle runs awaiting submission", () => {
  const roles = [
    ["planning", "planner"],
    ["in_progress", "implementer"],
    ["in_review", "reviewer"],
  ] as const;
  const at = (ms: number) =>
    new Date(Date.parse(now) + ms).toISOString() as typeof now;
  const reason = "idle_without_submission";
  const idleFixture = (stage: Stage = "in_progress") => {
    const f = fixture(stage);
    const role = roles.find(([s]) => s === stage)?.[1] ?? "implementer";
    const run = f.state.runs.find((r) => r.role === role);
    if (!run) throw new Error("missing run");
    f.state.runs = [run];
    f.observations.runs = f.observations.runs.filter((o) => o.runId === run.id);
    f.state.task.reviewRound = stage === "in_review" ? 1 : 0;
    return { ...f, run };
  };
  const derive = (f: ReturnType<typeof idleFixture>) =>
    deriveAttention({
      now: f.observations.now,
      previous: f.state.task.attention,
      stage: f.state.task.stage,
      blocked: f.state.task.blocked,
      failed: f.state.task.failed,
      budgetMinutes: null,
      activeElapsedMs: 0,
      runs: f.state.runs,
      questions: f.state.questions,
      messages: f.state.messages,
      stallAfterMs: f.state.config.stallAfterMs,
      unknownGraceMs: f.state.config.unknownGraceMs,
    });

  for (const [stage, role] of roles) {
    it(`${role} raises distinct attention at the deadline, without stopping or moving the task`, () => {
      const f = idleFixture(stage);
      const timeout = f.state.config.stallAfterMs;
      f.observations.now = at(timeout - 1);
      const before = fixed(f.state, f.observations);
      expect(before.next.task.attention.reasons).not.toContain(reason);
      expect(before.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "schedule",
            at: at(timeout),
            why: "stall_check",
          }),
        ]),
      );
      f.observations.now = at(timeout);
      const expired = fixed(before.next, f.observations);
      expect(expired.next.task.attention.reasons).toEqual([reason]);
      expect(expired.next.task.stage).toBe(stage);
      expect(expired.next.task.reviewRound).toBe(f.state.task.reviewRound);
      expect(expired.next.runs[0]?.endedAt).toBeNull();
      expect(
        expired.actions.some(
          (a) => a.kind === "stop_run" || a.kind === "start_run",
        ),
      ).toBe(false);
      f.state = expired.next;
      expect(derive(f).reasonRunIds[reason]).toEqual([f.run.id]);
      // Persisted state and unchanged polls keep both interval and reason timestamps.
      f.observations.now = at(timeout * 6);
      const later = fixed(expired.next, f.observations);
      expect(later.next.runs[0]?.idleSince).toBe(now);
      expect(later.next.task.attention.reasonSince[reason]).toBe(at(timeout));
    });

    it(`${role} clears attention after its accepted submission`, () => {
      const f = idleFixture(stage);
      f.observations.now = at(f.state.config.stallAfterMs);
      const expired = fixed(f.state, f.observations);
      expect(expired.next.task.attention.reasons).toContain(reason);
      f.observations.inputs = [
        mcp(
          role === "planner"
            ? { tool: "submit_plan", input: { plan } }
            : role === "reviewer"
              ? reviewCall()
              : submit(),
          role,
        ),
      ];
      expect(
        fixed(expired.next, f.observations).next.task.attention.reasons,
      ).not.toContain(reason);
    });
  }

  it("starts a full grace period when work stops, and clears/restarts it when work resumes", () => {
    const f = idleFixture();
    f.run.status = "working";
    const timeout = f.state.config.stallAfterMs;
    f.observations.now = at(timeout * 2);
    const stopped = fixed(f.state, f.observations);
    expect(stopped.next.runs[0]?.idleSince).toBe(at(timeout * 2));
    expect(stopped.next.task.attention.reasons).not.toContain(reason);
    f.observations.now = at(timeout * 3);
    const expired = fixed(stopped.next, f.observations);
    expect(expired.next.task.attention.reasons).toContain(reason);
    const o = f.observations.runs[0] as RunObservation;
    if (!o.provider.ok || o.provider.value?.provider !== "codex")
      throw new Error("missing Codex");
    o.provider.value.status = "active";
    o.provider.value.turns = [
      {
        id: "resumed",
        status: "inProgress",
        error: null,
        userMessageHashes: [],
      },
    ];
    o.activityAt = f.observations.now;
    const resumed = fixed(expired.next, f.observations);
    expect(resumed.next.task.attention.reasons).not.toContain(reason);
    expect(resumed.next.runs[0]?.idleSince).toBeNull();
    o.provider.value.status = "idle";
    f.observations.now = at(timeout * 3 + 1);
    const stoppedAgain = fixed(resumed.next, f.observations);
    expect(stoppedAgain.next.runs[0]?.idleSince).toBe(f.observations.now);
    expect(stoppedAgain.next.task.attention.reasons).not.toContain(reason);
  });

  it("fresh native activity resets the interval even if a whole turn happened between polls", () => {
    const f = idleFixture();
    f.run.idleSince = now;
    f.observations.now = at(f.state.config.stallAfterMs);
    const o = f.observations.runs[0] as RunObservation;
    o.activityAt = f.observations.now;
    const r = fixed(f.state, f.observations);
    expect(r.next.runs[0]?.idleSince).toBe(f.observations.now);
    expect(r.next.task.attention.reasons).not.toContain(reason);
  });

  it("supports legacy idle runs with only a launch timestamp", () => {
    const f = idleFixture();
    f.run.lastActivityAt = null;
    f.observations.now = at(f.state.config.stallAfterMs);
    expect(derive(f).attention.reasons).toContain(reason);
  });

  for (const stage of [
    "backlog",
    "todo",
    "plan_approval",
    "awaiting_approval",
    "merging",
    "done",
    "canceled",
  ] as const)
    it(`does not flag idle runs in ${stage}`, () => {
      const f = idleFixture(stage);
      f.observations.now = at(f.state.config.stallAfterMs);
      expect(derive(f).attention.reasons).not.toContain(reason);
    });

  const exclusions: [string, (f: ReturnType<typeof idleFixture>) => void][] = [
    [
      "external",
      (f) => {
        f.run.origin = "external";
      },
    ],
    [
      "ended",
      (f) => {
        f.run.endedAt = now;
        f.run.endReason = "submitted";
      },
    ],
    [
      "another role",
      (f) => {
        f.run.role = "planner";
      },
    ],
    [
      "unknown status",
      (f) => {
        f.run.status = "unknown";
      },
    ],
    [
      "blocked task",
      (f) => {
        f.state.task.blocked = {
          reason: "dependencies",
          since: now,
          detail: "Waiting",
          until: null,
          questionId: null,
        };
      },
    ],
    [
      "failed task",
      (f) => {
        f.state.task.failed = {
          reason: "action_failed",
          since: now,
          detail: "Failed",
          runId: f.run.id,
        };
      },
    ],
    ...(["pending", "sent"] as const).map(
      (status): [string, (f: ReturnType<typeof idleFixture>) => void] => [
        `${status} message`,
        (f) => {
          f.state.messages = [
            {
              id: "message" as never,
              runId: f.run.id,
              purpose: "human",
              text: "Continue",
              textHash: "hash",
              status,
              attempts: 1,
              transportRef: null,
              sentAt: now,
              delivered: null,
            },
          ];
        },
      ],
    ),
    [
      "unanswered question",
      (f) => {
        f.state.questions = [
          {
            id: "question" as never,
            taskId: f.run.taskId,
            runId: f.run.id,
            question: "Help?",
            options: [],
            blocking: false,
            askedAt: now,
            answer: null,
            answeredAt: null,
          },
        ];
      },
    ],
  ];
  for (const [name, setup] of exclusions)
    it(`does not flag ${name}`, () => {
      const f = idleFixture();
      f.observations.now = at(f.state.config.stallAfterMs);
      setup(f);
      expect(derive(f).attention.reasons).not.toContain(reason);
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
      "idle_without_submission",
      (f) => {
        f.observations.now = "2026-09-12T00:16:00.000Z" as typeof now;
      },
    ],
    [
      "observability_failure",
      (f) => {
        const run = f.state.runs[1] as Run;
        run.unknownSince = now;
        f.observations.runs[1] = {
          runId: run.id,
          resumable: null,
          activityAt: null,
          provider: { ok: false, at: now, reason: "Offline" },
          pane: null,
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
  it("keeps a since per reason, and the set's since is the earliest of them", () => {
    const f = fixture("awaiting_approval");
    const first = fixed(f.state, f.observations);
    expect(first.next.task.attention.reasons).toEqual(["needs_approval"]);
    expect(first.next.task.attention.reasonSince).toEqual({
      needs_approval: now,
    });

    // A second reason appears an hour later; the first keeps its own timestamp.
    const later = "2026-09-12T01:00:00.000Z" as typeof now;
    f.observations.now = later;
    first.next.task.failed = {
      reason: "action_failed",
      since: later,
      detail: "push failed",
      runId: null,
    };
    const both = fixed(first.next, f.observations);
    expect(both.next.task.attention.reasons).toEqual([
      "failed",
      "needs_approval",
    ]);
    expect(both.next.task.attention.reasonSince).toEqual({
      failed: later,
      needs_approval: now,
    });
    expect(both.next.task.attention.since).toBe(now);
  });
  it("reads a since per reason from the same rule the UI calls", () => {
    const f = fixture("plan_approval");
    const r = fixed(f.state, f.observations);
    const derived = deriveAttention({
      now: f.observations.now,
      previous: { reasons: [], reasonSince: {}, since: null },
      stage: r.next.task.stage,
      blocked: r.next.task.blocked,
      failed: r.next.task.failed,
      budgetMinutes: r.next.task.budgetMinutes,
      activeElapsedMs: r.next.activeElapsedMs,
      runs: r.next.runs,
      questions: r.next.questions,
      messages: r.next.messages,
      stallAfterMs: r.next.config.stallAfterMs,
      unknownGraceMs: r.next.config.unknownGraceMs,
    });
    expect(derived.attention).toEqual(r.next.task.attention);
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

it("attributes reasons to their source runs without including ended or external permission runs", () => {
  const f = fixture("in_progress");
  const run = f.state.runs[0];
  if (!run) throw new Error("missing run");
  const input = {
    now,
    previous: f.state.task.attention,
    stage: f.state.task.stage,
    blocked: null,
    failed: {
      reason: "non_retryable_error" as const,
      since: now,
      detail: "Failed",
      runId: run.id,
    },
    budgetMinutes: null,
    activeElapsedMs: 0,
    questions: [],
    messages: [],
    stallAfterMs: 10_000,
    unknownGraceMs: 10_000,
    runs: [
      { ...run, endedAt: null, blockedOn: "permission" as const },
      { ...run, id: "ended" as never, endedAt: now },
      {
        ...run,
        id: "external" as never,
        origin: "external" as const,
        blockedOn: "permission" as const,
      },
    ],
  };
  const derived = deriveAttention(input);
  expect(derived.reasonRunIds.provider_permission).toEqual([run.id]);
  expect(derived.reasonRunIds.failed).toEqual([run.id]);
  expect(deriveAttention({ ...input, stage: "done" }).reasonRunIds).toEqual({});
});
