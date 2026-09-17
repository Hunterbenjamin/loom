import { loadScenarios } from "@loom/fake-agent";
import { expect, test } from "vitest";
import { createHarness, ScenarioDriver } from "./test-support.js";

test("early native receipt survives delayed transport completion and result reconciliation", async () => {
  const h = await createHarness();
  try {
    const { task } = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Delivery timing",
      description: "Exercise interactive Claude with fake time.",
      providers: {
        planner: "claude",
        implementer: "claude",
        reviewer: "claude",
      },
    });
    h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
    const driver = new ScenarioDriver(
      h,
      await loadScenarios(
        new URL("./fixtures/permission.json", import.meta.url),
      ),
    );
    await driver.run({
      until: () =>
        h.store
          .loadTaskState(task.id)
          .runs.some((r) => r.role === "implementer" && r.status === "working"),
      maxSteps: 300,
    });
    const run = h.store
      .loadTaskState(task.id)
      .runs.find((r) => r.role === "implementer");
    if (!run?.sessionId) throw Error("Missing implementer session");
    const sessionId = run.sessionId;
    const writes = h.paneHost.writes.length;
    const startedAt = h.clock.now();
    let hookAt = startedAt;
    let completedAt = startedAt;
    const paste = h.paneHost.pasteText.bind(h.paneHost);
    h.paneHost.pasteText = async (ref, text) => {
      const result = await paste(ref, text);
      h.clock.advance(1_000);
      hookAt = h.clock.now();
      expect(h.providers.confirm(sessionId)?.text).toBe(text);
      h.clock.advance(1_000);
      completedAt = h.clock.now();
      return result;
    };
    const finish = h.store.outbox.finish.bind(h.store.outbox);
    h.store.outbox.finish = (key, version, input) => {
      const result = finish(key, version, input);
      if (input.result.kind === "send_message") h.clock.advance(30_000);
      return result;
    };
    h.coordinator.submitHuman(task.id, {
      type: "send_message",
      runId: run.id,
      text: "Apply the review fixes",
    });
    await h.coordinator.settle();
    const state = h.store.loadTaskState(task.id);
    const message = h.store
      .messages(task.id)
      .find((m) => m.text === "Apply the review fixes");
    expect(message).toMatchObject({
      status: "delivered",
      attempts: 1,
      sentAt: completedAt,
      transportAttempt: {
        startedAt,
        completedAt,
        sessionId,
        sessionEpoch: run.sessionEpoch,
        runAttempt: run.attempts,
      },
      delivered: { via: "claude_user_prompt_submit", at: hookAt },
      deliveryAttention: false,
    });
    expect(h.clock.now() > completedAt).toBe(true);
    expect(state.task.stage).toBe("in_progress");
    expect(state.task.attention.reasons).not.toContain("provider_input");
    expect(h.paneHost.writes).toHaveLength(writes + 1);
    const output = h.store.outbox
      .recent(task.id)
      .find((row) => row.key === `send_message:${message?.id}`)?.result;
    expect(output).toMatchObject({
      ok: true,
      output: { transportAttempt: message?.transportAttempt },
    });

    // A second message can flow, but settling/replaying durable results never pastes twice.
    h.coordinator.submitHuman(task.id, {
      type: "send_message",
      runId: run.id,
      text: "One more finding",
    });
    await h.coordinator.settle();
    h.coordinator.loop.enqueue(task.id);
    await h.coordinator.settle();
    expect(
      h.store.messages(task.id).find((m) => m.text === "One more finding")
        ?.status,
    ).toBe("delivered");
    expect(h.paneHost.writes).toHaveLength(writes + 2);
  } finally {
    await h.close();
  }
}, 30_000);

test.each([false, true])(
  "Claude registration after the first observation delivers the brief (early SessionStart: %s)",
  async (earlySessionStart) => {
    const h = await createHarness();
    try {
      const registerAt = Date.parse(h.clock.now()) + 2_000;
      const listSessions = h.adapters.claude.listSessions;
      const hookSummary = h.adapters.claude.hookSummary;
      h.adapters.claude.listSessions = async () =>
        Date.parse(h.clock.now()) < registerAt ? [] : listSessions();
      h.adapters.claude.hookSummary = async (id) => {
        const hooks = await hookSummary(id);
        if (!earlySessionStart && Date.parse(h.clock.now()) < registerAt)
          hooks.sessionStart = null;
        return hooks;
      };
      const { task } = h.coordinator.createTask({
        repoId: h.repo.id,
        title: "Delayed Claude registration",
        description: "The hook and registry become available independently.",
        providers: {
          planner: "claude",
          implementer: "codex",
          reviewer: "claude",
        },
      });
      h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
      await h.coordinator.settle();
      const run = h.store.loadTaskState(task.id).runs[0];
      if (!run?.sessionId || !run.pane) throw Error("Missing planner");
      expect(run).toMatchObject({
        status: "unknown",
        endedAt: null,
        attempts: 1,
      });
      expect(await h.paneHost.getPane(run.pane)).toMatchObject({ dead: false });
      expect(h.store.messages(task.id)[0]).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      expect(
        h.store.loadTaskState(task.id).task.attention.reasons,
      ).not.toContain("run_vanished");

      h.clock.advance(2_000);
      h.coordinator.loop.enqueue(task.id);
      await h.coordinator.settle();
      expect(h.providers.confirm(run.sessionId)?.text).toContain(
        "You are Loom's planner",
      );
      await h.coordinator.settle();
      expect(h.store.messages(task.id)[0]).toMatchObject({
        status: "delivered",
        attempts: 1,
      });
      expect(h.store.loadTaskState(task.id).runs[0]).toMatchObject({
        status: "working",
        endedAt: null,
        unknownSince: null,
        attempts: 1,
      });
      expect(h.paneHost.writes).toHaveLength(1);
    } finally {
      await h.close();
    }
  },
  30_000,
);

test("missing Claude registration uses unknown grace, then confirmed process death surfaces vanished", async () => {
  const h = await createHarness();
  try {
    h.adapters.claude.listSessions = async () => [];
    const { task } = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Missing Claude registration",
      description: "Uncertainty is distinct from process death.",
      providers: {
        planner: "claude",
        implementer: "codex",
        reviewer: "claude",
      },
    });
    h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    let state = h.store.loadTaskState(task.id);
    const run = state.runs[0];
    if (!run?.pane) throw Error("Missing planner pane");
    h.clock.advance(state.config.unknownGraceMs);
    h.coordinator.loop.enqueue(task.id);
    await h.coordinator.settle();
    state = h.store.loadTaskState(task.id);
    expect(state.runs[0]).toMatchObject({ status: "unknown", endedAt: null });
    expect(state.task.attention.reasons).toContain("observability_failure");
    expect(state.task.attention.reasons).not.toContain("run_vanished");

    h.paneHost.exit(run.pane, 1);
    await h.coordinator.settle();
    state = h.store.loadTaskState(task.id);
    expect(state.runs[0]).toMatchObject({
      status: "ended",
      endReason: "vanished",
      attempts: 1,
    });
    expect(state.task.attention.reasons).toContain("run_vanished");
    expect(h.store.messages(task.id)[0]).toMatchObject({
      status: "failed",
      attempts: 0,
    });
    expect(state.runs).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 30_000);
