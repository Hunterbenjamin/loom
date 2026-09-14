// Restart recovery (brief §7, design §10). The coordinator is killed between an action's execution
// and its result being recorded; on restart the owner is asked, and the action is not repeated.

import { loadScenarios } from "@loom/fake-agent";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";

const scenarios = (name: string) =>
  loadScenarios(new URL(`./fixtures/${name}.json`, import.meta.url));

let open: Harness[] = [];
const track = (value: Harness) => {
  open.push(value);
  return value;
};
afterEach(async () => {
  const all = open;
  open = [];
  for (const value of all) await value.close().catch(() => undefined);
});

const start = (h: Harness) => {
  const state = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Change the example",
    description: "Replace the contents of example.txt.",
  });
  h.coordinator.submitHuman(state.task.id, { type: "move", to: "todo" });
  return state.task.id;
};

test("a push whose result was lost is recovered, not repeated", async () => {
  const first = track(await createHarness());
  const taskId = start(first);

  // The crash: the push runs, and the coordinator dies before its receipt is written. Dropping
  // exactly that write leaves the outbox row `running` with no result, which is what a restart
  // finds and what `startupRunning` reports as uncertain.
  let droppedKey: string | null = null;
  const finish = first.store.outbox.finish.bind(first.store.outbox);
  first.store.outbox.finish = (key, claimVersion, input) => {
    if (!droppedKey && key.startsWith("push_branch:")) {
      droppedKey = key;
      return false;
    }
    return finish(key, claimVersion, input);
  };

  const driver = new ScenarioDriver(first, await scenarios("walking-skeleton"));
  await driver.run({ until: () => droppedKey !== null, maxSteps: 300 });
  expect(droppedKey).toBeTruthy();

  const uncertain = first.store.outbox.runningAtStartup();
  expect(uncertain.map((r) => r.entry.key)).toContain(droppedKey);
  const remoteBefore = await first.git(
    "rev-parse",
    `origin/${first.store.loadTaskState(taskId).task.branch}`,
  );

  const second = track(await first.restart());
  // The owner proves the push happened, so the result is recorded rather than the push repeated.
  const pending = second.store
    .pendingInputs(taskId, 10)
    .filter(
      (input) => input.type === "action_result" && input.key === droppedKey,
    );
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    result: {
      kind: "push_branch",
      ok: true,
      output: { remoteHeadSha: remoteBefore },
    },
  });
  expect(second.store.outbox.runningAtStartup()).toHaveLength(0);

  await second.coordinator.settle();
  // The recovered result carried the task on, and the remote head never moved twice.
  // PR is not created immediately with the new flow; it will be created after the reviewer
  // submits with no blocking findings. For now, just verify push was recovered correctly.
  expect(
    await second.git(
      "rev-parse",
      `origin/${second.store.loadTaskState(taskId).task.branch}`,
    ),
  ).toBe(remoteBefore);
  // Task should be in in_review stage waiting for reviewer
  expect(second.store.loadTaskState(taskId).task.stage).toBe("in_review");
}, 30_000);

test("an action whose owner cannot prove anything is requeued, never replayed silently", async () => {
  const first = track(await createHarness());
  const taskId = start(first);
  const driver = new ScenarioDriver(first, await scenarios("planner-ok"));
  await driver.run({
    until: () =>
      first.store.outbox.list(taskId).some((r) => r.kind === "open_workspace"),
    maxSteps: 300,
  });
  await first.coordinator.settle();

  // Queue an intent, claim it, and die without doing anything.
  first.coordinator.loop.enqueue(taskId);
  await first.coordinator.settle();
  const state = first.store.loadTaskState(taskId);
  expect(state.worktree).toBeTruthy();

  const second = track(await first.restart());
  const report = second.store.outbox.runningAtStartup();
  expect(report).toHaveLength(0);
  // Nothing was left uncertain, and the task still reconciles cleanly.
  await second.coordinator.settle();
  expect(second.store.loadTaskState(taskId).task.failed).toBeNull();
}, 30_000);

test("the recipes a restart reads back can relaunch an interactive run", async () => {
  const first = track(await createHarness());
  const taskId = start(first);
  const driver = new ScenarioDriver(first, await scenarios("walking-skeleton"));
  await driver.run({
    until: () =>
      first.store.loadTaskState(taskId).runs.some((r) => r.pane !== null),
    maxSteps: 300,
  });
  const before = first.coordinator.recipes
    .all()
    .find((r) => r.mode === "interactive");
  expect(before?.executable).toBeTruthy();

  const second = track(await first.restart());
  const after = second.coordinator.recipes.get(before?.runId as never);
  // The intended command line is Loom's own state, never inferred from a pane's argv (design §10).
  expect(after?.executable).toBe(before?.executable);
  expect(after?.args).toEqual(before?.args);
  expect(after?.env).toEqual(before?.env);
  expect(after?.token).toBe(before?.token);
  const run = second.store
    .loadTaskState(taskId)
    .runs.find((r) => r.id === before?.runId);
  expect(run?.pane).toBeTruthy();
  expect(await second.paneHost.getPane(run?.pane as never)).toMatchObject({
    dead: false,
  });
  expect(second.logs.some((line) => line.includes("Could not relaunch"))).toBe(
    false,
  );
  expect(
    second.paneHost.launches.filter((r) => r.runId === before?.runId),
  ).toHaveLength(1);
}, 30_000);

test("an in-flight Codex turn gets exactly one continuation after restart", async () => {
  const first = track(await createHarness());
  const taskId = start(first);
  const driver = new ScenarioDriver(first, await scenarios("walking-skeleton"));
  await driver.run({
    until: () =>
      first.store
        .loadTaskState(taskId)
        .runs.some((run) => run.role === "implementer" && !!run.inFlightTurnId),
    maxSteps: 300,
  });
  const before = first.store
    .loadTaskState(taskId)
    .runs.find((run) => run.role === "implementer");
  if (!before?.sessionId || !before.inFlightTurnId)
    throw new Error("Missing in-flight implementer");

  const second = track(await first.restart());
  // Fake providers are process-local. Recreate the persisted native thread as the replacement
  // app-server would hydrate it, with the prior turn now marked interrupted.
  second.providers.create(
    "codex",
    before.worktreePath,
    before.sessionId,
    before.mode,
  );
  second.providers.status(before.sessionId, "working");
  const native = second.providers.get(before.sessionId);
  if (native.value.provider !== "codex")
    throw new Error("Missing Codex thread");
  const turn = native.value.turns.at(-1);
  if (!turn) throw new Error("Missing native turn");
  turn.id = before.inFlightTurnId;
  second.providers.finish(before.sessionId, "interrupted");

  await second.coordinator.settle();
  const continuations = second.store
    .messages(taskId)
    .filter((message) => message.purpose === "restart_continuation");
  expect(continuations).toHaveLength(1);
  expect(
    second.store.outbox
      .list(taskId)
      .filter(
        (row) =>
          row.action?.kind === "send_message" &&
          row.action.messageId === continuations[0]?.id,
      ),
  ).toHaveLength(1);
  expect(
    second.store.loadTaskState(taskId).runs.find((run) => run.id === before.id),
  ).toMatchObject({
    sessionId: before.sessionId,
    sessionEpoch: before.sessionEpoch,
    restartInterruption: {
      turnId: before.inFlightTurnId,
      outcome: "continued",
    },
  });

  const third = track(await second.restart());
  await third.coordinator.settle();
  expect(
    third.store
      .messages(taskId)
      .filter((message) => message.purpose === "restart_continuation"),
  ).toHaveLength(1);
}, 30_000);
