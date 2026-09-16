import { applyPatch, pullRequestKey, stateFromSnapshot } from "@loom/protocol";
import { expect, test } from "vitest";
import { minutesBefore } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { emptySnapshot } from "../live/snapshot.js";
import {
  readyToMergeCount,
  reviewAgentWorking,
  reviewGroups,
  reviewNeedsHuman,
  selectedPullRequests,
} from "./pull-requests.js";

test("live snapshots and PR patches update rows and retain the selected repo/number", () => {
  const fixture = buildSnapshot();
  const wire = toSnapshot(fixture);
  const client = stateFromSnapshot(wire.meta, wire.body);
  const store = createStore(emptySnapshot());
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
  expect(
    selectedPullRequests(store.getState()).some(
      (pr) => pr.title === "Just opened",
    ),
  ).toBe(true);
  expect(
    selectedPullRequests(store.getState()).at(
      store.getState().ui.prCursor ?? -1,
    ),
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
  expect(store.getState().ui.prCursor).toBeNull();
});

test("PR lists, counts and subscriptions follow exactly one selected repository", async () => {
  const { pullRequestSubscriptions } = await import("./pull-requests.js");
  const { viewCounts } = await import("./selectors.js");
  const store = createStore();
  store.setView("pull-requests");
  store.setTrackerVisible(true);
  store.getState().ui.repo = "";
  for (const repo of store.getState().snapshot.repos) {
    store.setPrCursor(3);
    const wire = toSnapshot(store.getState().snapshot);
    wire.body.projects = [{ id: "project", repoId: repo.id }];
    store.applyProtocol(stateFromSnapshot(wire.meta, wire.body));
    expect(store.getState().ui.prCursor).toBeNull();
    const rows = selectedPullRequests(store.getState());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.repoId === repo.id)).toBe(true);
    expect(
      viewCounts(store.getState().snapshot, repo.id)["pull-requests"],
    ).toBe(rows.length);
    expect(pullRequestSubscriptions(store.getState())).toEqual([
      { kind: "pull_requests", repoId: repo.id, state: "open" },
      { kind: "pull_requests", repoId: repo.id, state: "merged" },
      { kind: "pull_requests", repoId: repo.id, state: "closed" },
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
  store.setPrTab("created");
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
  client.collections.project.set("project", {
    id: "project",
    repoId: other.id,
  });
  store.applyProtocol(client);
  expect(readyToMergeCount(store.getState())).toBe(0);
});

test("For you distinguishes required reviews and unrelated failures; Created follows viewer identity", () => {
  const fixture = buildSnapshot();
  const first = fixture.pullRequests[0];
  if (!first) throw new Error("Missing PR");
  fixture.pullRequests = [
    {
      ...first,
      number: 1,
      taskId: null,
      viewerDidAuthor: false,
      review: "none",
      reviewRequired: true,
    },
    { ...first, number: 2, viewerDidAuthor: false, checks: "failure" },
    { ...first, number: 3, viewerDidAuthor: true, review: "changes_requested" },
    {
      ...first,
      number: 4,
      viewerDidAuthor: false,
      viewerReviewRequested: true,
      review: "none",
      reviewRequired: true,
    },
    { ...first, number: 5, viewerDidAuthor: true, checks: "pending" },
    {
      ...first,
      number: 6,
      viewerDidAuthor: false,
      review: "none",
      reviewRequired: false,
    },
    { ...first, number: 7, viewerDidAuthor: true, draft: true },
  ];
  const store = createStore(fixture);
  expect(
    reviewGroups(store.getState()).map((g) => [
      g.id,
      g.rows.map((pr) => pr.number),
    ]),
  ).toEqual([
    ["ready", [6]],
    ["attention", [3]],
    ["waiting", [5, 4]],
    ["created", [7]],
    ["completed", []],
  ]);
  expect(
    fixture.pullRequests.filter(reviewNeedsHuman).map((pr) => pr.number),
  ).toEqual([3, 4, 6]);
  store.setPrTab("created");
  expect(selectedPullRequests(store.getState()).map((pr) => pr.number)).toEqual(
    [7, 5, 3],
  );
});

test("working glyph follows provider run state, never a stage or native terminal process", () => {
  const fixture = buildSnapshot();
  const pr = fixture.pullRequests[0];
  const run = fixture.runs[0];
  if (!pr?.taskId || !run) throw new Error("Missing fixture link");
  fixture.runs = [{ ...run, taskId: pr.taskId, status: "working" }];
  const store = createStore(fixture);
  expect(reviewAgentWorking(store.getState(), pr)).toBe(true);
  for (const status of ["idle", "unknown", "failed"] as const) {
    fixture.runs = [{ ...run, taskId: pr.taskId, status }];
    expect(reviewAgentWorking(createStore(fixture).getState(), pr)).toBe(false);
  }
  expect(reviewAgentWorking(store.getState(), { ...pr, taskId: null })).toBe(
    false,
  );
});
