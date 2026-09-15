import { applyPatch, stateFromSnapshot } from "@loom/protocol";
import { expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { attentionCount, INBOX_SECTIONS, inboxRows } from "./inbox.js";
import { selectedRows } from "./selectors.js";

test("one row per supplied reason, section order then oldest first; filters do not affect the global count", () => {
  const store = createStore(buildSnapshot());
  const state = store.getState();
  const rows = inboxRows(state);
  expect(rows).toHaveLength(attentionCount(state));
  expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  expect(rows.map((row) => row.section)).toEqual(
    rows
      .map((row) => row.section)
      .sort(
        (a, b) =>
          INBOX_SECTIONS.findIndex((section) => section.id === a) -
          INBOX_SECTIONS.findIndex((section) => section.id === b),
      ),
  );
  for (const section of INBOX_SECTIONS) {
    const times = rows
      .filter((row) => row.section === section.id)
      .map((row) => row.since);
    expect(times).toEqual([...times].sort());
  }
  for (const row of rows)
    expect(row.since).toBe(row.task.attention.reasonSince[row.reason]);
  const repo = state.snapshot.repos[0];
  if (!repo) throw new Error("missing repo");
  for (const row of inboxRows(store.getState()))
    expect(row.task.repoId).toBe(repo.id);
  expect(attentionCount(store.getState())).toBe(rows.length);
});

test("detail patches preserve task-list and inbox selector identities", () => {
  const store = createStore(buildSnapshot());
  const { meta, body } = toSnapshot(store.getState().snapshot);
  const client = stateFromSnapshot(meta, body);
  store.applyProtocol(client);
  const beforeList = selectedRows(store.getState());
  const beforeInbox = inboxRows(store.getState());
  const transition = body.transitions[0];
  if (!transition) throw new Error("missing transition");
  const patch = {
    type: "patch" as const,
    seq: meta.seq + 1,
    now: meta.now,
    changes: [
      {
        op: "upsert" as const,
        collection: "transition" as const,
        value: { ...transition, reason: "Changed activity" },
      },
    ],
  };
  expect(applyPatch(client, patch).ok).toBe(true);
  store.applyProtocol(client, patch);
  expect(selectedRows(store.getState())).toBe(beforeList);
  expect(inboxRows(store.getState())).toBe(beforeInbox);
  store.setCursor(2);
  expect(inboxRows(store.getState())).toBe(beforeInbox);
});

test("live actions never mutate the snapshot before the coordinator publishes", async () => {
  const store = createStore(buildSnapshot());
  const snapshot = store.getState().snapshot;
  const task = snapshot.tasks[0];
  if (!task) throw new Error("missing task");
  const send = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: "guard_failed" as const,
      message: "Stale approval",
      details: [],
    },
  }));
  store.setSender(send);
  await store.command({
    kind: "human",
    taskId: task.id,
    command: { type: "retry" },
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(store.getState().snapshot).toBe(snapshot);
  expect(store.getState().ui.toast).toContain("Stale approval");
  store.moveTask(task.id, "in_review");
  expect(store.getState().snapshot).toBe(snapshot);
});
