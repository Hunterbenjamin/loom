import { describe, expect, it } from "vitest";
import {
  actionInput,
  command,
  config,
  fixed,
  fixture,
  now,
} from "../test/fixtures.js";
import type {
  Action,
  IsoTime,
  Run,
  RunObservation,
  TransportAttempt,
} from "./index.js";
import { normalizeText, reconcile } from "./index.js";

function queued(provider: "codex" | "claude" = "codex", working = false) {
  const f = fixture();
  const run = f.state.runs.find((r) => r.provider === provider) as Run;
  const observation = f.observations.runs.find(
    (o) => o.runId === run.id,
  ) as RunObservation;
  if (
    observation.provider.ok &&
    observation.provider.value?.provider === "codex" &&
    working
  ) {
    observation.provider.value.status = "active";
    observation.provider.value.turns = [
      { id: "turn1", status: "inProgress", error: null, userMessageHashes: [] },
    ];
  }
  f.observations.inputs = [
    command({
      type: "send_message",
      runId: run.id,
      text: "Hello\tworld\r\nNext",
    }),
  ];
  const initial = fixed(f.state, f.observations);
  const action = initial.actions.find(
    (a) => a.kind === "send_message",
  ) as Action;
  return { ...f, run, observation, action, state: initial.next };
}
function prepared(provider: "codex" | "claude" = "codex", working = false) {
  const f = queued(provider, working);
  f.observations.inputs = [
    actionInput(f.action, {
      transportRef: provider === "codex" ? "turn1" : null,
    }),
  ];
  return { ...f, state: reconcile(f.state, f.observations).next };
}
describe("delivery requires provider evidence", () => {
  it("normalizes tabs and CRLF before hashing", () => {
    expect(normalizeText("A\tB\r\nC")).toBe("A    B\nC");
    const f = prepared();
    expect(f.state.messages[0]?.textHash).toBe(
      config.sha256("Hello    world\nNext"),
    );
  });
  it("transport success marks sent only", () => {
    const f = prepared();
    expect(f.state.messages[0]?.status).toBe("sent");
  });
  it("Codex start snapshot confirms the returned turn", () => {
    const f = prepared();
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "codex"
    )
      f.observation.provider.value.turns = [
        {
          id: "turn1",
          status: "completed",
          error: null,
          userMessageHashes: [],
        },
      ];
    const r = fixed(f.state, f.observations);
    expect(r.next.messages[0]).toMatchObject({
      status: "delivered",
      delivered: { via: "codex_turn_started", turnId: "turn1" },
    });
  });
  it("Codex start rejects a different turn", () => {
    const f = prepared();
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "codex"
    )
      f.observation.provider.value.turns = [
        {
          id: "other",
          status: "completed",
          error: null,
          userMessageHashes: [],
        },
      ];
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("steer requires matching text item in expected turn", () => {
    const f = prepared("codex", true);
    expect(f.state.messages[0]?.status).toBe("sent");
    const p = f.observation.provider;
    if (p.ok && p.value?.provider === "codex" && p.value.turns[0])
      p.value.turns[0].userMessageHashes = [
        f.state.messages[0]?.textHash ?? "",
      ];
    expect(fixed(f.state, f.observations).next.messages[0]).toMatchObject({
      status: "delivered",
      delivered: { via: "codex_user_message_item" },
    });
  });
  it("a written paste alone never delivers", () => {
    const f = prepared("claude");
    f.observation.pane = {
      ok: true,
      at: now,
      value: {
        ref: {
          hostGeneration: "loom-dev#1",
          sessionName: "loom-t1",
          windowId: "@1",
          paneId: "%1",
        },
        cwd: f.run.worktreePath,
        startCwd: f.run.worktreePath,
        pid: 4242,
        command: "node",
        dead: false,
        exitCode: null,
      },
    };
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("Claude matches normalized prompt receipt", () => {
    const f = prepared("claude");
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "claude"
    )
      f.observation.provider.value.hooks.promptSubmits = [
        {
          promptId: "prompt1",
          textHash: f.state.messages[0]?.textHash ?? "",
          at: now,
        },
      ];
    expect(fixed(f.state, f.observations).next.messages[0]).toMatchObject({
      status: "delivered",
      delivered: { via: "claude_user_prompt_submit", promptId: "prompt1" },
    });
  });
  it("unavailable provider cannot confirm a message", () => {
    const f = prepared();
    f.observation.provider = { ok: false, at: now, reason: "Offline" };
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("stale Claude receipt cannot acknowledge identical new text", () => {
    const f = prepared("claude");
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "claude"
    )
      f.observation.provider.value.hooks.promptSubmits = [
        {
          promptId: "old",
          textHash: f.state.messages[0]?.textHash ?? "",
          at: "2026-09-11T00:00:00.000Z" as typeof now,
        },
      ];
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("resends once with same message ID and unique attempt key", () => {
    const f = prepared();
    f.observations.now = "2026-09-12T00:00:11.000Z" as typeof now;
    const r = fixed(f.state, f.observations);
    const retry = r.actions.find((a) => a.kind === "send_message");
    expect(retry).toMatchObject({
      messageId: f.state.messages[0]?.id,
      key: `send_message:${f.state.messages[0]?.id}#2`,
    });
    if (!retry) throw Error("Missing retry");
    f.observations.inputs = [
      actionInput(retry, { transportRef: "turn2" }, "retry-result"),
    ];
    const sent = reconcile(r.next, f.observations);
    f.observations.now = "2026-09-12T00:00:22.000Z" as typeof now;
    const expired = fixed(sent.next, f.observations);
    expect(expired.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(expired.next.task.attention.reasons).toContain("provider_input");
  });
  it("working or new turn at timeout requires human inspection", () => {
    const f = prepared("codex", true);
    f.observations.now = "2026-09-12T00:00:11.000Z" as typeof now;
    const r = fixed(f.state, f.observations);
    expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(r.next.task.attention.reasons).toContain("provider_input");
  });
  it("raises attention when capacity prevents a timed-out send from retrying", () => {
    const f = prepared();
    f.observations.capacity.caps.total = 0;
    f.observations.now = "2026-09-12T00:00:10.000Z" as typeof now;
    const r = fixed(f.state, f.observations);
    expect(r.next.messages[0]).toMatchObject({
      status: "sent",
      attempts: 1,
      deliveryAttention: true,
    });
    expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(r.actions).toContainEqual(
      expect.objectContaining({
        kind: "notify",
        title: expect.stringContaining("could not be resent: no capacity"),
      }),
    );
  });
  for (const text of ["/clear", "!rm file", "  /command"])
    it(`prefixes unsafe generated text ${text}`, () => {
      const f = fixture();
      const run = f.state.runs[1] as Run;
      f.observations.inputs = [
        command({ type: "send_message", runId: run.id, text }),
      ];
      const r = fixed(f.state, f.observations);
      expect(r.next.messages[0]?.text).toBe(`Loom message:\n${text}`);
    });
  it("unknown provider blocks send even with a live pane", () => {
    const f = fixture();
    const run = f.state.runs[1] as Run;
    const o = f.observations.runs[1] as RunObservation;
    o.provider = { ok: false, reason: "Offline", at: now };
    f.observations.inputs = [
      command({ type: "send_message", runId: run.id, text: "Hello" }),
    ];
    expect(
      fixed(f.state, f.observations).actions.some(
        (a) => a.kind === "send_message",
      ),
    ).toBe(false);
  });
});

describe("executor timing survives delayed reconciliation", () => {
  const startedAt = "2026-09-12T00:00:01.000Z" as IsoTime;
  const hookAt = "2026-09-12T00:00:02.000Z" as IsoTime;
  const completedAt = "2026-09-12T00:00:03.000Z" as IsoTime;
  const reconciledAt = "2026-09-12T00:00:40.000Z" as IsoTime;

  function delayed() {
    const f = queued("claude");
    const p = f.observation.provider;
    if (!p.ok || p.value?.provider !== "claude") throw Error("Missing Claude");
    const transportAttempt: TransportAttempt = {
      startedAt,
      completedAt,
      sessionId: p.value.sessionId,
      sessionEpoch: f.run.sessionEpoch,
      runAttempt: f.run.attempts,
    };
    p.at = reconciledAt;
    p.value.hooks.promptSubmits = [
      {
        promptId: "early-hook",
        textHash: f.state.messages[0]?.textHash ?? "",
        at: hookAt,
      },
    ];
    f.observations.now = reconciledAt;
    const input = actionInput(f.action, {
      transportRef: null,
      transportAttempt,
    });
    input.receivedAt = completedAt;
    f.observations.inputs = [input];
    return { ...f, provider: p.value, transportAttempt };
  }

  it("accepts an early hook after delayed action result and releases the follow-up exactly once", () => {
    const f = delayed();
    // The hook can be observed while the transport result is still pending.
    const waiting = fixed(f.state, { ...f.observations, inputs: [] });
    expect(waiting.next.messages[0]?.status).toBe("pending");
    expect(waiting.actions.some((a) => a.kind === "send_message")).toBe(false);
    const r = fixed(waiting.next, f.observations);
    expect(r.next.messages[0]).toMatchObject({
      status: "delivered",
      sentAt: completedAt,
      transportAttempt: f.transportAttempt,
      delivered: { promptId: "early-hook", at: hookAt },
      deliveryAttention: false,
    });
    expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(r.transitions).toEqual([]);
    f.observations.inputs = [
      command(
        {
          type: "send_message",
          runId: f.run.id,
          text: "Fix the review findings",
        },
        "follow-up",
      ),
    ];
    const follow = fixed(r.next, f.observations);
    expect(
      follow.actions.filter((a) => a.kind === "send_message"),
    ).toHaveLength(1);
    expect(
      fixed(follow.next, f.observations).actions.filter(
        (a) => a.kind === "send_message",
      ),
    ).toHaveLength(0);
  });

  for (const invalid of [
    "old receipt",
    "wrong hash",
    "wrong session",
    "old epoch",
    "old run attempt",
  ] as const) {
    it(`rejects ${invalid} despite delayed reconciliation`, () => {
      const f = delayed();
      const receipt = f.provider.hooks.promptSubmits[0];
      if (!receipt) throw Error("Missing receipt");
      if (invalid === "old receipt") receipt.at = now;
      if (invalid === "wrong hash") receipt.textHash = "different";
      if (invalid === "wrong session")
        f.provider.sessionId = "other-session" as typeof f.run.sessionId &
          string;
      if (invalid === "old epoch") f.transportAttempt.sessionEpoch++;
      if (invalid === "old run attempt") f.transportAttempt.runAttempt++;
      const r = fixed(f.state, f.observations);
      expect(r.next.messages[0]?.status).not.toBe("delivered");
      expect(r.next.messages[0]?.delivered).toBeNull();
      expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
    });
  }

  it("unblocks an already queued fix_round when the original's early hook is reconciled", () => {
    const f = delayed();
    const original = f.state.messages[0];
    if (!original) throw Error("Missing original");
    original.purpose = "initial";
    f.state.messages.push({
      ...original,
      id: `${original.id}:fix` as typeof original.id,
      purpose: "fix_round",
      text: "Fix review findings",
      textHash: config.sha256("Fix review findings"),
      status: "pending",
      attempts: 0,
    });
    const waiting = fixed(f.state, { ...f.observations, inputs: [] });
    expect(waiting.actions.some((a) => a.kind === "send_message")).toBe(false);
    const r = fixed(waiting.next, f.observations);
    expect(r.next.messages[0]?.status).toBe("delivered");
    expect(r.actions.filter((a) => a.kind === "send_message")).toMatchObject([
      { messageId: `${original.id}:fix` },
    ]);
    // Replayed action results with a different inbox ID cannot regress delivery or resend.
    const duplicate = {
      ...f.observations.inputs[0],
      id: "duplicate-result",
    } as (typeof f.observations.inputs)[number];
    const replayed = fixed(r.next, { ...f.observations, inputs: [duplicate] });
    expect(replayed.next.messages[0]?.status).toBe("delivered");
    expect(replayed.actions.some((a) => a.kind === "send_message")).toBe(false);
  });

  it("never retries a previous session's sent message into the replacement session", () => {
    const f = delayed();
    f.transportAttempt.sessionEpoch++;
    f.provider.hooks.promptSubmits = [];
    const r = fixed(f.state, f.observations);
    expect(r.next.messages[0]).toMatchObject({
      status: "failed",
      deliveryAttention: false,
    });
    expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(r.next.task.attention.reasons).not.toContain("provider_input");
  });

  it("does not let a receipt from the first send acknowledge the retry", () => {
    const f = prepared("claude");
    f.observations.now = "2026-09-12T00:00:11.000Z" as IsoTime;
    const retry = fixed(f.state, f.observations);
    const action = retry.actions.find((a) => a.kind === "send_message");
    if (!action) throw Error("Missing retry");
    const p = f.observation.provider;
    if (!p.ok || p.value?.provider !== "claude") throw Error("Missing Claude");
    p.at = reconciledAt;
    p.value.hooks.promptSubmits = [
      {
        promptId: "old-attempt",
        textHash: f.state.messages[0]?.textHash ?? "",
        at: hookAt,
      },
    ];
    f.observations.now = reconciledAt;
    f.observations.inputs = [
      actionInput(
        action,
        {
          transportRef: null,
          transportAttempt: {
            startedAt: "2026-09-12T00:00:12.000Z",
            completedAt: "2026-09-12T00:00:13.000Z",
            sessionId: f.run.sessionId,
            sessionEpoch: f.run.sessionEpoch,
            runAttempt: f.run.attempts,
          },
        },
        "retry-result",
      ),
    ];
    const r = fixed(retry.next, f.observations);
    expect(r.next.messages[0]).toMatchObject({
      status: "sent",
      attempts: 2,
      delivered: null,
      deliveryAttention: true,
    });
    expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
  });

  it("uses persisted receipt time for legacy action results", () => {
    const f = queued("claude");
    f.observations.now = reconciledAt;
    const input = actionInput(f.action, { transportRef: null });
    input.receivedAt = completedAt;
    f.observations.inputs = [input];
    expect(fixed(f.state, f.observations).next.messages[0]?.sentAt).toBe(
      completedAt,
    );
  });

  it("retires a legacy sent message before resuming the same run ID", () => {
    const f = prepared("claude");
    const old = f.state.runs.find((r) => r.id === f.run.id);
    const original = f.state.messages[0];
    if (!old || !original) throw Error("Missing history");
    old.endedAt = now;
    old.endReason = "submitted";
    old.status = "ended";
    original.deliveryAttention = true;
    f.state.desiredRun = { role: old.role, round: old.round, resume: true };
    f.state.messages.push({
      ...original,
      id: `${original.id}:follow` as typeof original.id,
      purpose: "fix_round",
      status: "pending",
      attempts: 0,
      sentAt: null,
      deliveryAttention: false,
    });
    f.observations.inputs = [];
    const launched = fixed(f.state, f.observations);
    expect(launched.next.messages[0]).toMatchObject({
      status: "failed",
      deliveryAttention: false,
    });
    const action = launched.actions.find((a) => a.kind === "start_run");
    if (!action) throw Error("Missing launch");
    f.observations.inputs = [
      actionInput(
        action,
        { sessionId: old.sessionId, codexGeneration: null, pane: null },
        "launch-result",
      ),
    ];
    const ready = fixed(launched.next, f.observations);
    expect(
      ready.actions.filter((a) => a.kind === "send_message"),
    ).toMatchObject([{ messageId: `${original.id}:follow` }]);
    expect(ready.next.task.attention.reasons).not.toContain("provider_input");
  });

  it("ignores historical sent messages and their attention when a different run sends", () => {
    const f = prepared("claude");
    const old = f.state.runs.find((r) => r.id === f.run.id);
    const message = f.state.messages[0];
    if (!old || !message) throw Error("Missing history");
    old.endedAt = now;
    old.endReason = "submitted";
    old.status = "ended";
    message.deliveryAttention = true;
    const current = f.state.runs.find((r) => r.role === "implementer");
    if (!current) throw Error("Missing new run");
    f.observations.now = reconciledAt;
    f.observations.inputs = [
      command(
        { type: "send_message", runId: current.id, text: "Fix findings" },
        "new-run-message",
      ),
    ];
    const r = fixed(f.state, f.observations);
    expect(r.next.task.attention.reasons).not.toContain("provider_input");
    expect(r.actions.filter((a) => a.kind === "send_message")).toMatchObject([
      { runId: current.id },
    ]);
    expect(r.next.messages[0]).toMatchObject({
      status: "sent",
      delivered: null,
    });
  });
});

describe("bounded pending delivery", () => {
  const deadline = "2026-09-12T00:00:10.000Z" as typeof now;
  const beforeDeadline = "2026-09-12T00:00:09.999Z" as typeof now;

  function queuedReviewer() {
    const f = fixture("in_review");
    const run = f.state.runs[2] as Run;
    f.observations.inputs = [
      command({
        type: "send_message",
        runId: run.id,
        text: "Review this change",
      }),
    ];
    return { ...f, run };
  }

  function expectAttention(
    result: ReturnType<typeof reconcile>,
    run: Run,
    reason: string,
  ) {
    expect(result.next.task.stage).toBe("in_review");
    expect(result.next.task.attention.reasons).toContain("provider_input");
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        kind: "notify",
        title: expect.stringContaining(reason),
        body: expect.stringContaining(run.id),
      }),
    );
  }

  it("times out capacity-starved reviewer input at the fixed deadline, without duplicate notifications", () => {
    const f = queuedReviewer();
    f.observations.capacity.caps.total = 0;
    const queued = fixed(f.state, f.observations);
    expect(queued.next.messages[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      pendingSince: now,
    });
    expect(queued.actions).toContainEqual(
      expect.objectContaining({
        kind: "schedule",
        at: deadline,
        why: "delivery_timeout",
      }),
    );
    expect(queued.next.task.attention.reasons).not.toContain("provider_input");
    f.observations.now = beforeDeadline;
    const waiting = fixed(queued.next, f.observations);
    expect(waiting.next.task.attention.reasons).not.toContain("provider_input");
    f.observations.now = deadline;
    const expired = fixed(waiting.next, f.observations);
    expectAttention(expired, f.run, "no capacity for the reviewer role");
    expect(expired.next.messages[0]).toMatchObject({
      attempts: 0,
      deliveryAttention: true,
      pendingSince: now,
    });
    expect(expired.actions.some((a) => a.kind === "send_message")).toBe(false);
    f.observations.now = "2026-09-12T00:30:00.000Z" as typeof now;
    const repeated = fixed(expired.next, f.observations);
    expect(repeated.actions.some((a) => a.kind === "notify")).toBe(false);
    expect(repeated.next.task.attention.reasonSince.provider_input).toBe(
      deadline,
    );
  });

  for (const status of ["pending", "sent"] as const) {
    it(`names the earlier ${status} message blocking the same run`, () => {
      const f = queuedReviewer();
      const initial = fixed(f.state, f.observations);
      const action = initial.actions.find(
        (a) => a.kind === "send_message",
      ) as Action;
      let state = initial.next;
      if (status === "sent") {
        f.observations.inputs = [actionInput(action, { transportRef: null })];
        state = fixed(state, f.observations).next;
        // Keep the earlier send awaiting evidence without entering its retry path.
        const earlier = state.messages[0];
        if (!earlier) throw Error("Missing earlier message");
        earlier.attempts = 2;
      }
      f.observations.inputs = [
        command(
          { type: "send_message", runId: f.run.id, text: "Follow up" },
          "follow-up",
        ),
      ];
      const queued = fixed(state, f.observations);
      expect(queued.next.messages[1]).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      expect(queued.actions.some((a) => a.kind === "send_message")).toBe(false);
      f.observations.now = beforeDeadline;
      expect(
        fixed(queued.next, f.observations).next.messages[1]?.deliveryAttention,
      ).not.toBe(true);
      f.observations.now = deadline;
      const expired = fixed(queued.next, f.observations);
      expectAttention(
        expired,
        f.run,
        `earlier message ${state.messages[0]?.id} is still ${status}`,
      );
      expect(expired.next.messages[1]).toMatchObject({
        deliveryAttention: true,
        attempts: 0,
      });
      expect(expired.actions.some((a) => a.kind === "send_message")).toBe(
        false,
      );
    });
  }

  it("surfaces an active Codex snapshot with no observable turn", () => {
    const f = fixture();
    const run = f.state.runs[0] as Run;
    const observation = f.observations.runs[0] as RunObservation;
    if (
      observation.provider.ok &&
      observation.provider.value?.provider === "codex"
    )
      observation.provider.value.status = "active";
    f.observations.inputs = [
      command({ type: "send_message", runId: run.id, text: "Continue" }),
    ];
    const queued = fixed(f.state, f.observations);
    f.observations.now = deadline;
    const expired = fixed(queued.next, f.observations);
    expect(expired.next.messages[0]).toMatchObject({
      attempts: 0,
      deliveryAttention: true,
    });
    expect(expired.actions).toContainEqual(
      expect.objectContaining({
        kind: "notify",
        title: expect.stringContaining("the run is unknown"),
      }),
    );
  });

  it("bounds a missing transport result and clears attention only on provider confirmation", () => {
    const f = queuedReviewer();
    const queued = fixed(f.state, f.observations);
    const action = queued.actions.find(
      (a) => a.kind === "send_message",
    ) as Action;
    f.observations.now = deadline;
    const expired = fixed(queued.next, f.observations);
    expectAttention(expired, f.run, "transport action is pending");
    expect(expired.next.messages[0]?.attempts).toBe(1);
    expect(expired.actions.some((a) => a.kind === "send_message")).toBe(false);
    const result = actionInput(action, { transportRef: null });
    result.receivedAt = deadline;
    f.observations.inputs = [result];
    const sent = fixed(expired.next, f.observations);
    expect(sent.next.messages[0]).toMatchObject({
      status: "sent",
      deliveryAttention: true,
    });
    const observation = f.observations.runs[2] as RunObservation;
    observation.provider.at = deadline;
    if (
      observation.provider.ok &&
      observation.provider.value?.provider === "claude"
    )
      observation.provider.value.hooks.promptSubmits = [
        {
          promptId: "receipt",
          textHash: sent.next.messages[0]?.textHash ?? "",
          at: deadline,
        },
      ];
    const delivered = fixed(sent.next, f.observations);
    expect(delivered.next.messages[0]).toMatchObject({
      status: "delivered",
      deliveryAttention: false,
    });
    expect(delivered.next.task.attention.reasons).not.toContain(
      "provider_input",
    );
  });

  it("bounds a message selected before its fresh send gate becomes unknown", () => {
    const f = queuedReviewer();
    const selected = fixed(f.state, f.observations);
    expect(selected.actions.some((a) => a.kind === "send_message")).toBe(true);
    const observation = f.observations.runs[2] as RunObservation;
    observation.provider = {
      ok: false,
      reason: "connection lost before transport",
      at: now,
    };
    const unknown = fixed(selected.next, f.observations);
    expect(unknown.next.runs.find((run) => run.id === f.run.id)?.status).toBe(
      "unknown",
    );
    expect(unknown.next.messages[0]).toMatchObject({
      status: "pending",
      pendingSince: now,
    });
    expect(unknown.next.messages[0]?.deliveryAttention).not.toBe(true);
    f.observations.now = deadline;
    const expired = fixed(unknown.next, f.observations);
    expectAttention(expired, f.run, "transport action is pending");
    expect(expired.next.messages[0]?.deliveryAttention).toBe(true);
    expect(expired.actions.some((a) => a.kind === "send_message")).toBe(false);
  });

  it("sends once when capacity returns before the deadline", () => {
    const f = queuedReviewer();
    f.observations.capacity.caps.total = 0;
    const queued = fixed(f.state, f.observations);
    f.observations.now = beforeDeadline;
    f.observations.capacity.caps.total = 4;
    const released = fixed(queued.next, f.observations);
    expect(
      released.actions.filter((a) => a.kind === "send_message"),
    ).toHaveLength(1);
    expect(released.next.messages[0]).toMatchObject({
      pendingSince: now,
      attempts: 1,
    });
    expect(released.next.task.attention.reasons).not.toContain(
      "provider_input",
    );
  });

  it("initializes legacy pending age once and preserves it across reloads", () => {
    const f = queuedReviewer();
    f.observations.capacity.caps.total = 0;
    const queued = fixed(f.state, f.observations);
    delete queued.next.messages[0]?.pendingSince;
    queued.next.outbox = [];
    f.observations.now = deadline;
    const migrated = fixed(queued.next, f.observations);
    expect(migrated.next.messages[0]?.pendingSince).toBe(deadline);
    expect(migrated.next.task.attention.reasons).not.toContain(
      "provider_input",
    );
    const reloaded = {
      ...migrated.next,
      messages: JSON.parse(JSON.stringify(migrated.next.messages)),
    };
    f.observations.now = "2026-09-12T00:00:20.000Z" as typeof now;
    expectAttention(
      fixed(reloaded, f.observations),
      f.run,
      "no capacity for the reviewer role",
    );
  });
});
