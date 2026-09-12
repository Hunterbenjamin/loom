// The send gate (brief §4). In spike 06 a paste into a pending permission dialog approved the
// command instead of delivering a prompt, so a run the provider reports as waiting — or reports
// nothing about at all — receives nothing.

import type { Run } from "@loom/core";
import { loadScenarios } from "@loom/fake-agent";
import { afterEach, expect, test } from "vitest";
import { gateStatus } from "./gate.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";

test("the gate permits only idle and working", () => {
  expect(gateStatus({ status: "idle", blockedOn: null })).toMatchObject({
    ok: true,
  });
  expect(gateStatus({ status: "working", blockedOn: null })).toMatchObject({
    ok: true,
  });
  for (const status of [
    "unknown",
    "starting",
    "failed",
    "ended",
  ] as Run["status"][])
    expect(gateStatus({ status, blockedOn: null })).toMatchObject({
      ok: false,
    });
  expect(
    gateStatus({ status: "blocked", blockedOn: "permission" }),
  ).toMatchObject({ ok: false, reason: expect.stringContaining("permission") });
  expect(gateStatus({ status: "blocked", blockedOn: "input" })).toMatchObject({
    ok: false,
  });
  // A status that reads idle while a dialog is still up is still uncertainty, not permission.
  expect(gateStatus({ status: "idle", blockedOn: "permission" })).toMatchObject(
    {
      ok: false,
    },
  );
});

let open: Harness[] = [];
afterEach(async () => {
  const all = open;
  open = [];
  for (const value of all) await value.close().catch(() => undefined);
});

test("a run waiting at a permission dialog receives no paste", async () => {
  const h = await createHarness();
  open.push(h);
  const state = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Change the example",
    description: "Replace the contents of example.txt.",
    providers: { planner: "claude", implementer: "claude", reviewer: "claude" },
  });
  const taskId = state.task.id;
  h.coordinator.submitHuman(taskId, { type: "move", to: "todo" });
  const driver = new ScenarioDriver(
    h,
    await loadScenarios(new URL("./fixtures/permission.json", import.meta.url)),
  );
  await driver.run({
    until: () =>
      h.store
        .loadTaskState(taskId)
        .runs.some((r) => r.role === "implementer" && r.status === "working"),
    maxSteps: 300,
  });

  const implementer = h.store
    .loadTaskState(taskId)
    .runs.find((r) => r.role === "implementer");
  expect(implementer?.mode).toBe("interactive");
  const writes = h.paneHost.writes.length;

  // The provider now reports a pending permission dialog, and the human sends a message anyway.
  h.providers.request(implementer?.sessionId as never, "approval", "rm -rf /");
  h.coordinator.submitHuman(taskId, {
    type: "send_message",
    runId: implementer?.id as never,
    text: "please continue",
  });
  await h.coordinator.settle();

  // Nothing was written into the pane, and the refusal is a precondition, not a retry.
  expect(h.paneHost.writes).toHaveLength(writes);
  const blocked = h.store.loadTaskState(taskId);
  expect(blocked.runs.find((r) => r.id === implementer?.id)?.blockedOn).toBe(
    "permission",
  );
  const message = blocked.messages.find((m) => m.text === "please continue");
  expect(message?.status).not.toBe("delivered");
  const refused = h.store.outbox
    .list(taskId)
    .filter((row) => row.kind === "send_message" && row.error);
  for (const row of refused) expect(row.error?.code).toBe("precondition");

  // Once the human answers the dialog in the terminal, the message can be delivered.
  h.providers.answer(implementer?.sessionId as never, "accept");
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();
  expect(h.paneHost.writes.length).toBeGreaterThan(writes);
}, 30_000);
