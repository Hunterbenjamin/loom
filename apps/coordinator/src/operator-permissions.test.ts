import { loadScenarios } from "@loom/fake-agent";
import { afterEach, expect, test } from "vitest";
import {
  foldHookSummary,
  MemoryHookLog,
} from "../../../packages/adapters/claude/src/hooks.js";
import { attentionOccurrence } from "./operator-policy.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";
import { taskRows } from "./views.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
});

test("consecutive native Claude permission receipts create distinct attention and guarded answers", async () => {
  const harness = await createHarness();
  h = harness;
  const { coordinator, store, providers, paneHost, clock } = harness;
  const taskId = coordinator.createTask({
    repoId: harness.repo.id,
    title: "Permission occurrences",
    description: "Test native permission handling",
    providers: { planner: "claude", implementer: "claude", reviewer: "codex" },
  }).task.id;
  coordinator.submitHuman(taskId, { type: "move", to: "todo" });
  const scripts = await loadScenarios(
    new URL("./fixtures/walking-skeleton.json", import.meta.url),
  );
  for (const script of scripts)
    if (script.agent.role === "implementer") script.agent.provider = "claude";
  await new ScenarioDriver(harness, scripts).run({
    until: () => store.loadTaskState(taskId).task.stage === "in_progress",
  });
  const run = store
    .runs(taskId)
    .find((r) => r.role === "implementer" && !r.endedAt);
  if (!run?.sessionId) throw new Error("Missing interactive run");
  const sessionId = run.sessionId;
  const provider = providers.get(sessionId).value;
  if (provider.provider !== "claude" || !provider.agentsEntry)
    throw new Error("Missing Claude provider");
  const log = new MemoryHookLog();
  const prompt = async (command: string) => {
    await log.append({
      sessionId,
      event: "PermissionRequest",
      promptId: null,
      receivedAt: clock.now(),
      payload: {
        session_id: sessionId,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command },
      },
    });
    // No idle observation, no clock advance, and no tool_use_id in this native hook.
    provider.hooks = foldHookSummary(await log.bySession(sessionId));
    if (!provider.agentsEntry) throw new Error("Missing live provider");
    provider.agentsEntry.status = provider.agentsEntry.rawStatus = "waiting";
    await coordinator.loop.pass(taskId);
    const state = store.loadTaskState(taskId);
    const occurrence = attentionOccurrence(state);
    const event = store.operator
      .pending()
      .find((e) => e.kind === "attention" && e.occurrence === occurrence);
    if (!event) throw new Error("Missing new attention event");
    expect(state.runs.find((r) => r.id === run.id)?.pendingDialog).toEqual(
      provider.hooks.pendingDialog,
    );
    return { state, event };
  };
  const inbox = async () =>
    (
      await taskRows(
        {
          store,
          adapters: harness.adapters,
          config: harness.config,
          recipes: coordinator.recipes,
          now: () => clock.now(),
        },
        taskId,
      )
    ).rows.find((row) => row.collection === "inbox");

  const first = await prompt("unapproved-command");
  expect(
    await coordinator.operator.invoke("append_note", {
      eventId: first.event.id,
    }),
  ).toMatchObject({ result: { accepted: true } });
  const note = store.operator
    .notes(taskId)
    .find((n) => n.eventId === first.event.id && n.forHuman);
  if (!note) throw new Error("Missing escalation note");
  expect(note.body).toContain("unapproved-command");
  expect(await inbox()).toMatchObject({
    value: { forHuman: { noteId: note.id } },
  });

  const second = await prompt("pnpm install");
  expect(second.event.id).not.toBe(first.event.id);
  expect(second.state.task.attention).toEqual(first.state.task.attention);
  expect(await inbox()).toMatchObject({ value: { forHuman: null } });
  expect(
    await coordinator["command"]({
      kind: "claim_notification",
      noteId: note.id,
    }),
  ).toMatchObject({ result: { notice: null } });
  const writes = paneHost.writes.length;
  expect(
    await coordinator.operator.invoke("answer_pane_prompt", {
      eventId: second.event.id,
    }),
  ).toMatchObject({ result: { accepted: true } });
  await coordinator.settle();
  expect(paneHost.writes.slice(writes).map((w) => w.text)).toContain("1");
  expect(paneHost.keys.at(-1)?.key).toBe("Enter");
  expect(
    store.outbox
      .list(taskId)
      .some(
        (r) =>
          r.action?.kind === "answer_pane_prompt" &&
          r.action.expectedDialog?.requestId ===
            provider.hooks.pendingDialog?.requestId,
      ),
  ).toBe(true);

  // An unprocessed receipt cannot approve a newer native dialog.
  const third = await prompt("pnpm install");
  const fourth = await prompt("another-unapproved-command");
  expect(third.event.id).not.toBe(second.event.id);
  const before = paneHost.writes.length;
  expect(
    await coordinator.operator.invoke("answer_pane_prompt", {
      eventId: third.event.id,
    }),
  ).toMatchObject({
    result: { accepted: false, reason: "Stale attention occurrence" },
  });
  expect(paneHost.writes).toHaveLength(before);
  await coordinator.operator.invoke("append_note", {
    eventId: fourth.event.id,
  });
  const nextNote = store.operator
    .notes(taskId)
    .find((n) => n.eventId === fourth.event.id && n.forHuman);
  expect(nextNote?.id).not.toBe(note.id);
  expect(
    await coordinator["command"]({
      kind: "claim_notification",
      noteId: nextNote?.id,
    }),
  ).toMatchObject({ result: { notice: { id: nextNote?.id } } });
  expect(
    await coordinator["command"]({
      kind: "claim_notification",
      noteId: nextNote?.id,
    }),
  ).toMatchObject({ result: { notice: null } });
  expect(await inbox()).toMatchObject({
    value: { forHuman: { noteId: nextNote?.id } },
  });
}, 30_000);
