import type { PaneObservation } from "@loom/core";
import { FakePaneHost } from "@loom/fake-agent";
import { expect, test, vi } from "vitest";
import { fixture, now, run } from "../../../packages/core/test/fixtures.js";
import { assemblePanes, PaneInventory, paneKey } from "./pane-inventory.js";
import { PublishedRows } from "./views.js";

const observation: PaneObservation = {
  ref: {
    hostGeneration: "test#1",
    sessionName: "native",
    windowId: "@1",
    paneId: "%1",
  },
  sessionId: "$1",
  windowName: "shell",
  title: "native title",
  cwd: null,
  startCwd: "/tmp" as never,
  pid: 42,
  command: "sh",
  dead: true,
  exitCode: 7,
};
test("joins only unique recorded generation-aware run references, retaining native unlinked and Lead panes", () => {
  const { state: s } = fixture();
  const r = run();
  r.pane = observation.ref;
  s.runs = [r];
  const assemble = () =>
    assemblePanes(
      [observation],
      [s],
      new Map([["native", 3]]),
      now,
      null,
      false,
    )[0];
  expect(assemble()).toMatchObject({
    runId: r.id,
    taskId: s.task.id,
    dead: true,
    exitStatus: 7,
    attachedClients: 3,
  });
  s.runs = [r, { ...r, id: "other" as never }];
  expect(assemble()?.runId).toBe(null);
  s.runs = [{ ...r, pane: { ...observation.ref, hostGeneration: "old" } }];
  expect(assemble()?.taskId).toBe(null);
  expect(
    assemblePanes(
      [observation],
      [],
      new Map(),
      now,
      paneKey(observation.ref),
      true,
    )[0],
  ).toMatchObject({ taskId: null, attention: true, title: "native title" });
});
test("coalesces scans, counts each session once, emits semantic deltas, retains on failure and disposes pending work", async () => {
  const host = new FakePaneHost();
  const list = vi
    .spyOn(host, "listPanes")
    .mockResolvedValue([
      observation,
      { ...observation, ref: { ...observation.ref, paneId: "%2" } },
    ]);
  const clients = vi
    .spyOn(host, "listClients")
    .mockResolvedValue([{ id: "client", cols: 100, rows: 24 }]);
  const published = new PublishedRows();
  const patches: unknown[] = [];
  const inventory = new PaneInventory(
    host,
    { currentBranch: vi.fn().mockResolvedValue("main") },
    () => ({ states: [], now, leadPane: null, leadWaiting: false }),
    (rows) =>
      patches.push(
        ...published.replace(
          "panes",
          null,
          rows.map((value) => ({ collection: "pane", key: value.id, value })),
        ),
      ),
  );
  await inventory.refresh();
  expect(clients).toHaveBeenCalledTimes(1);
  expect(patches).toHaveLength(2);
  await inventory.refresh();
  expect(patches).toHaveLength(2);
  list.mockRejectedValueOnce(new Error("offline"));
  await inventory.refresh();
  expect(inventory.rows).toHaveLength(2);
  expect(inventory.unavailable).toBe(true);
  list.mockResolvedValue([]);
  await inventory.refresh();
  expect(inventory.rows).toEqual([]);
  expect(inventory.unavailable).toBe(false);
  let release: (v: PaneObservation[]) => void = () => {};
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = inventory.refresh();
  inventory.refresh();
  inventory.refresh();
  const before = list.mock.calls.length;
  release([]);
  await pending;
  expect(list.mock.calls.length).toBe(before + 1);
  await inventory.stop();
  await inventory.refresh();
  expect(list.mock.calls.length).toBe(before + 1);
});

test("assembles task branches and caches unlinked cwd reads per refresh, isolating unreadable paths", async () => {
  const { state } = fixture();
  const recorded = run();
  recorded.pane = observation.ref;
  state.runs = [recorded];
  const native = (paneId: string, sessionName: string, cwd: string) => ({
    ...observation,
    ref: { ...observation.ref, paneId, sessionName },
    startCwd: cwd as PaneObservation["startCwd"],
  });
  const host = new FakePaneHost();
  vi.spyOn(host, "listClients").mockResolvedValue([]);
  vi.spyOn(host, "listPanes").mockResolvedValue([
    observation,
    native("%2", state.worktree?.paneWorkspaceId ?? "", "/task-shell"),
    native("%3", "scratch", "/repo/subdir"),
    native("%4", "scratch", "/repo/subdir"),
    native("%5", "unreadable", "/missing"),
    native("%6", "unreadable", "/missing"),
    native("%7", "detached", "/detached"),
  ]);
  let branch = "main";
  let unreadable = true;
  const git = {
    currentBranch: vi.fn(async (cwd: string) => {
      if (cwd === "/missing" && unreadable) throw new Error("Not readable");
      return cwd === "/detached" ? null : branch;
    }),
  };
  const inventory = new PaneInventory(
    host,
    git,
    () => ({ states: [state], now, leadPane: null, leadWaiting: false }),
    vi.fn(),
  );
  await inventory.refresh();
  expect(inventory.rows.map((row) => row.branch)).toEqual([
    state.task.branch,
    state.task.branch,
    "main",
    "main",
    null,
    null,
    "HEAD",
  ]);
  expect(git.currentBranch.mock.calls.map(([cwd]) => cwd)).toEqual([
    "/repo/subdir",
    "/missing",
    "/detached",
  ]);
  expect(inventory.unavailable).toBe(false);
  expect(inventory.rows.every((row) => !row.unavailable)).toBe(true);
  branch = "feat/switched";
  unreadable = false;
  state.task.branch = "feat/task-updated";
  await inventory.refresh();
  expect(inventory.rows.map((row) => row.branch)).toEqual([
    "feat/task-updated",
    "feat/task-updated",
    branch,
    branch,
    branch,
    branch,
    "HEAD",
  ]);
  expect(git.currentBranch).toHaveBeenCalledTimes(6);
  await inventory.stop();
});
