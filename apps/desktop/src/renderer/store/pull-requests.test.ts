import { applyPatch, pullRequestKey, stateFromSnapshot } from "@loom/protocol";
import { expect, test } from "vitest";
import { minutesBefore } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { emptySnapshot } from "../live/snapshot.js";
import { selectedPullRequests } from "./pull-requests.js";
import { createStore } from "./store.js";

test("live snapshots and PR patches update rows and retain the selected repo/number", () => {
  const fixture = buildSnapshot();
  const wire = toSnapshot(fixture);
  const client = stateFromSnapshot(wire.meta, wire.body);
  const store = createStore(emptySnapshot(), true);
  store.applyProtocol(client);
  store.setView("pull-requests");
  store.setPrCursor(2);
  const selected = selectedPullRequests(store.getState())[2];
  if (!selected) throw new Error("missing selected PR");
  const newer = {
    ...selected,
    number: 999,
    createdAt: minutesBefore(0),
    title: "Just opened",
  };
  const patch = {
    type: "patch" as const,
    seq: wire.meta.seq + 1,
    now: wire.meta.now,
    changes: [
      {
        op: "upsert" as const,
        collection: "pull_request" as const,
        value: newer,
      },
    ],
  };
  const applied = applyPatch(client, patch);
  if (!applied.ok) throw new Error("patch rejected");
  store.applyProtocol(client, patch);
  expect(selectedPullRequests(store.getState())[0]?.title).toBe("Just opened");
  expect(
    selectedPullRequests(store.getState())[store.getState().ui.prCursor],
  ).toEqual(selected);
  const removal = {
    ...patch,
    seq: patch.seq + 1,
    changes: [
      {
        op: "delete" as const,
        collection: "pull_request" as const,
        key: pullRequestKey(selected.repoId, selected.number),
        taskId: selected.taskId,
      },
    ],
  };
  const removed = applyPatch(client, removal);
  if (!removed.ok) throw new Error("remove rejected");
  store.applyProtocol(client, removal);
  expect(selectedPullRequests(store.getState())).not.toContainEqual(selected);
  // A reconnect replaces the disposable projection, including previously cached rows.
  store.applyProtocol(
    stateFromSnapshot(wire.meta, { ...wire.body, pullRequests: [] }),
  );
  expect(store.getState().snapshot.pullRequests).toEqual([]);
  expect(store.getState().ui.prCursor).toBe(0);
});

test("PR lists, counts and subscriptions follow exactly one selected repository", async () => {
  const { pullRequestSubscriptions } = await import("./pull-requests.js");
  const { viewCounts } = await import("./selectors.js");
  const store = createStore();
  store.setView("pull-requests");
  store.setTrackerVisible(true);
  for (const repo of store.getState().snapshot.repos) {
    store.setPrCursor(3);
    await store.setRepo(repo.id);
    expect(store.getState().ui.prCursor).toBe(0);
    const rows = selectedPullRequests(store.getState());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.repoId === repo.id)).toBe(true);
    expect(
      viewCounts(store.getState().snapshot, repo.id)["pull-requests"],
    ).toBe(rows.length);
    expect(pullRequestSubscriptions(store.getState())).toEqual([
      { kind: "pull_requests", repoId: repo.id, state: "open" },
    ]);
  }
});
