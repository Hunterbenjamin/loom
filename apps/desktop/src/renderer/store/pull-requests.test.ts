import { applyPatch, pullRequestKey, stateFromSnapshot } from "@loom/protocol";
import { expect, test } from "vitest";
import { minutesBefore } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { emptySnapshot } from "../live/snapshot.js";
import { readyToMergeCount, selectedPullRequests } from "./pull-requests.js";
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

test("readiness follows GitHub patches and the selected repository, independent of list filters", async () => {
  const fixture = buildSnapshot();
  const first = fixture.pullRequests[0];
  if (!first) throw new Error("Missing PR");
  fixture.pullRequests = [
    {
      ...first,
      checks: "success",
      mergeable: "mergeable",
      draft: false,
      state: "open",
    },
    {
      ...first,
      number: 901,
      checks: "none",
      mergeable: "mergeable",
      draft: false,
      state: "open",
    },
    ...(
      [
        { checks: "pending" },
        { checks: "failure" },
        { draft: true },
        { mergeable: "unknown" },
        { mergeable: "conflicting" },
        { state: "merged" },
        { state: "closed" },
      ] as const
    ).map((change, index) => ({ ...first, number: 902 + index, ...change })),
  ];
  const store = createStore(fixture);
  expect(readyToMergeCount(store.getState())).toBe(2);
  store.setPrQuery("nothing matches");
  store.setPrState("closed");
  expect(readyToMergeCount(store.getState())).toBe(2);
  const wire = toSnapshot(fixture);
  const client = stateFromSnapshot(wire.meta, wire.body);
  const patch = {
    type: "patch" as const,
    seq: wire.meta.seq + 1,
    now: wire.meta.now,
    changes: [
      {
        op: "upsert" as const,
        collection: "pull_request" as const,
        value: {
          ...first,
          checks: "success" as const,
          mergeable: "mergeable" as const,
          draft: false,
          state: "merged" as const,
        },
      },
    ],
  };
  expect(applyPatch(client, patch).ok).toBe(true);
  store.applyProtocol(client, patch);
  expect(readyToMergeCount(store.getState())).toBe(1);
  const other = fixture.repos[1];
  if (!other) throw new Error("Missing repository");
  await store.setRepo(other.id);
  expect(readyToMergeCount(store.getState())).toBe(0);
});
