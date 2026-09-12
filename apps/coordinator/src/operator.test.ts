import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(autoFix = false) {
  const h = await createHarness({
    config: {
      operator: {
        policy: "v1",
        autoFix: autoFix ? ["pass_failed"] : [],
        maxFiledPerHour: 5,
        repoId: "example-repo",
      },
    },
  });
  cleanups.push(() => h.close());
  return h;
}
async function file(h: Harness, message: string) {
  h.coordinator.operator.failure("pass_failed", null, message);
  const e = h.store.operator.pending().find((e) => e.message === message);
  if (!e) throw new Error("missing event");
  const input = {
    eventId: e.id,
    title: "Runtime failure",
    description: "The coordinator cannot finish a pass.",
    acceptanceTest: "Inject the failure and assert reconciliation can recover.",
  };
  const result = await h.coordinator.operator.invoke("file_task", input);
  return { e, input, result };
}
test("equivalent failures dedupe and redelivery adds no evidence", async () => {
  const h = await setup();
  const a = await file(h, "Task t-12345678 failed on /tmp/task-a line 17");
  await file(h, "Task t-87654321 failed on /tmp/task-b line 88");
  expect(h.store.tasks()).toHaveLength(1);
  const task = h.store.tasks()[0];
  if (!task) throw new Error("task");
  expect(task.stage).toBe("backlog");
  expect(task.description).toContain("Acceptance test:");
  expect(task.signature).toContain("v1:pass_failed");
  expect(h.store.operator.notes(task.id)).toHaveLength(2);
  await h.coordinator.operator.invoke("file_task", a.input);
  expect(h.store.operator.notes(task.id)).toHaveLength(2);
  expect(h.store.operator.count(h.clock.now())).toBe(1);
});
test("quota is instance-wide, dedupe precedes quota, autoFix input is durable", async () => {
  const h = await setup(true);
  for (const message of [
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "zeta",
    "eta",
  ])
    await file(h, message);
  expect(h.store.tasks()).toHaveLength(5);
  expect(h.coordinator.operator.state().escalation).toContain(
    "2 distinct events",
  );
  const task = h.store.tasks()[0];
  if (!task) throw new Error("task");
  expect(h.store.pendingInputs(task.id, 10)).toMatchObject([
    { command: { type: "move", to: "todo" } },
  ]);
  h.coordinator.operator.failure("pass_failed", null, "alpha");
  expect(h.store.operator.count(h.clock.now())).toBe(5);
});
test("autoFix starts a planner through normal reconciliation", async () => {
  const h = await setup(true);
  await file(h, "planner launch regression");
  await h.coordinator.settle();
  const task = h.store.tasks()[0];
  if (!task) throw new Error("task");
  expect(task.stage).toBe("planning");
  expect(h.store.runs(task.id)).toEqual([
    expect.objectContaining({ role: "planner", origin: "loom" }),
  ]);
  expect(
    h.store.transitions(task.id).map((transition) => transition.to),
  ).toEqual(expect.arrayContaining(["todo", "planning"]));
});
test("one headless identity is saved before launch and stopped events remain durable", async () => {
  const h = await setup();
  const original = h.adapters.claude.startHeadless;
  const launch = vi.fn(async (req: Parameters<typeof original>[0]) => {
    const recipe = JSON.parse(
      await readFile(
        join(h.store.dataDirectory, "operator/recipe.json"),
        "utf8",
      ),
    );
    expect(recipe.sessionId).toBe(req.sessionId);
    expect(req.mcpOnly).toBe(true);
    await original(req);
  });
  h.adapters.claude.startHeadless = launch;
  h.coordinator.operator.failure("pass_failed", null, "launch evidence");
  await Promise.all([
    h.coordinator.operator.pump(),
    h.coordinator.operator.pump(),
  ]);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(h.paneHost.launches).toHaveLength(0);
  await h.coordinator.operator.stop();
  h.coordinator.operator.failure(
    "publish_failed",
    null,
    "queued while stopped",
  );
  await h.coordinator.operator.pump();
  expect(launch).toHaveBeenCalledTimes(1);
  expect(h.store.operator.pending()).toHaveLength(2);
  const saved = JSON.parse(
    await readFile(join(h.store.dataDirectory, "operator/recipe.json"), "utf8"),
  );
  expect(h.coordinator.operator.resolve(saved.token)).toEqual({
    kind: "operator",
    active: false,
  });
});
test("unroutable incidents remain visible without creating a task", async () => {
  const h = await createHarness();
  cleanups.push(() => h.close());
  await file(h, "unroutable");
  expect(h.store.tasks()).toHaveLength(0);
  expect(h.store.operator.pending()).toHaveLength(1);
  expect(h.coordinator.operator.state().escalation).toContain(
    "operator.repoId",
  );
});

test("restart retains stop intent, queue, identity, dedupe and hourly accounting", async () => {
  let h = await setup();
  await file(h, "first persisted failure");
  await h.coordinator.operator.pump();
  const sessionId = h.coordinator.operator.sessionId;
  await h.coordinator.operator.stop();
  h.coordinator.operator.failure(
    "publish_failed",
    null,
    "pending across restart",
  );
  cleanups.pop();
  h = await h.restart();
  cleanups.push(() => h.close());
  expect(h.coordinator.operator.state()).toMatchObject({
    sessionId,
    status: "stopped",
    queueLength: 1,
    filedThisHour: 1,
  });
  await h.coordinator.operator.open();
  expect(h.coordinator.operator.sessionId).toBe(sessionId);
  const pending = h.store.operator.pending()[0];
  if (!pending) throw new Error("pending");
  await h.coordinator.operator.invoke("file_task", {
    eventId: pending.id,
    title: "Publish failure",
    description: "Publication failed",
    acceptanceTest: "Inject a publish failure with no desktop connected.",
  });
  expect(h.store.tasks()).toHaveLength(2);
  expect(h.store.operator.pending()).toHaveLength(0);
});

test("in-turn arrivals attach to the next tool result and do not start a second child", async () => {
  const h = await setup();
  const launch = vi.spyOn(h.adapters.claude, "startHeadless");
  h.coordinator.operator.failure("pass_failed", null, "first arrival");
  await h.coordinator.operator.pump();
  h.coordinator.operator.failure("publish_failed", null, "second arrival");
  await h.coordinator.operator.pump();
  const response = (await h.coordinator.operator.invoke(
    "operator_events",
    {},
  )) as { events: Array<{ message: string }> };
  expect(response.events.map((e) => e.message)).toEqual(["second arrival"]);
  expect(launch).toHaveBeenCalledTimes(1);
});

test("forbidden commands are refused even after an event was processed", async () => {
  const h = await setup();
  const { e } = await file(h, "policy bypass attempt");
  for (const name of [
    "create_task",
    "move_task",
    "approve_plan",
    "approve_merge",
    "cancel_task",
  ])
    expect(
      await h.coordinator.operator.invoke(name, { eventId: e.id }),
    ).toMatchObject({ result: { accepted: false } });
  expect(h.store.tasks()).toHaveLength(1);
});

test("quota uses one escalation note and repeated failures retain occurrence counts", async () => {
  const h = await setup();
  for (const message of [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
  ])
    await file(h, message);
  expect(
    h.store.operator.notes().filter((n) => n.outcome === "rate_limited"),
  ).toHaveLength(1);
  const event = h.store.operator.event(
    h.store.operator.notes().find((n) => n.outcome === "rate_limited")
      ?.eventId ?? "",
  );
  if (!event) throw new Error("quota event");
  h.coordinator.operator.failure("pass_failed", null, event.message);
  expect(h.store.operator.event(event.id)?.count).toBe(2);
});
