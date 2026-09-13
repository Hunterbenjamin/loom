import { expect, test, vi } from "vitest";
import { createHarness } from "./test-support.js";

test("unknown run retry launches a new thread and delivers its pending follow-up", async () => {
  const h = await createHarness({
    config: { providerOverrides: { planner: "codex" } },
  });
  try {
    const task = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Retry planner",
      description: "",
    });
    h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    const before = h.store.loadTaskState(task.task.id).runs[0];
    if (!before?.sessionId) throw new Error("Missing session");
    const read = vi
      .spyOn(h.providers.codex, "readThread")
      .mockRejectedValue(new Error("Observer lost"));
    h.coordinator.submitHuman(task.task.id, {
      type: "send_message",
      runId: before.id,
      text: "Keep the existing changes",
    });
    await h.coordinator.settle();
    expect(h.store.loadTaskState(task.task.id).runs[0]?.status).toBe("unknown");
    const retry = h.coordinator.submitHuman(task.task.id, { type: "retry" });
    await h.coordinator.loop.pass(task.task.id);
    expect(h.store.inputDisposition(task.task.id, retry)).toMatchObject({
      accepted: true,
    });
    expect(
      h.store.outbox
        .list(task.task.id)
        .some((row) => row.action?.kind === "stop_run" && row.action.terminate),
    ).toBe(true);
    read.mockRestore();
    await h.coordinator.settle();
    const after = h.store.loadTaskState(task.task.id).runs[0];
    expect(after).toMatchObject({
      id: before.id,
      attempts: 2,
      sessionEpoch: 1,
    });
    expect(after?.sessionId).not.toBe(before.sessionId);
    expect(
      h.store.outbox
        .list(task.task.id)
        .find(
          (row) => row.action?.kind === "start_run" && row.action.attempt === 2,
        )?.status,
    ).toBe("succeeded");
    expect(
      h.providers
        .get(after?.sessionId as never)
        .queue.some((m) => m.text.includes("Keep the existing changes")),
    ).toBe(true);
    expect(h.providers.confirm(after?.sessionId as never)).toBeTruthy();
    h.coordinator.loop.enqueue(task.task.id);
    await h.coordinator.settle();
    expect(
      h.store
        .messages(task.task.id)
        .some(
          (m) =>
            m.text.includes("Keep the existing changes") &&
            m.status === "delivered",
        ),
    ).toBe(true);
  } finally {
    await h.close();
  }
}, 30_000);
