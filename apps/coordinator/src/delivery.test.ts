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
