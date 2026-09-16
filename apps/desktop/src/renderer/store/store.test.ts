import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { groupRows, rowsFor, sortRows, viewCounts } from "./selectors.js";

function store() {
  return createStore(buildSnapshot());
}

/** The fixtures always have these; a missing one is a broken fixture, not a failed assertion. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}

describe("views", () => {
  it("counts the same tasks the view shows", () => {
    const snapshot = buildSnapshot();
    const counts = viewCounts(snapshot, "repo-loom");
    for (const view of [
      "all",
      "needs-you",
      "in-progress",
      "awaiting-approval",
      "done",
    ] as const) {
      expect(counts[view]).toBe(rowsFor(snapshot, view, "repo-loom").length);
    }
  });

  it("filters by repository", () => {
    const snapshot = buildSnapshot();
    const repo = must(snapshot.repos[1]);
    const rows = rowsFor(snapshot, "all", repo.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.task.repoId).toBe(repo.id);
  });
});

describe("the list", () => {
  it("sorts by work time either way, keeping issues without one at the bottom", () => {
    const rows = rowsFor(buildSnapshot(), "all", "repo-loom");
    for (const descending of [false, true]) {
      const sorted = sortRows(rows, "time", descending);
      const timed = sorted.filter((row) => row.workMinutes !== null);
      expect(timed.length).toBeGreaterThan(1);
      expect(sorted.slice(0, timed.length)).toEqual(timed);
      const minutes = timed.map((row) => row.workMinutes as number);
      const ordered = [...minutes].sort((a, b) => (descending ? b - a : a - b));
      expect(minutes).toEqual(ordered);
    }
  });

  it("groups by stage without losing or duplicating a row", () => {
    const rows = sortRows(
      rowsFor(buildSnapshot(), "all", "repo-loom"),
      "stage",
      false,
    );
    const items = groupRows(rows);
    const listed = items.filter((item) => item.kind === "row");
    expect(listed).toHaveLength(rows.length);
    const headers = items.filter((item) => item.kind === "header");
    expect(headers.reduce((total, header) => total + header.count, 0)).toBe(
      rows.length,
    );
  });
});

describe("actions", () => {
  it("ignores a move to the stage a task is already in", () => {
    const api = store();
    const task = must(api.getState().snapshot.tasks[0]);
    const before = api.getState().snapshot;
    api.moveTask(task.id, task.stage);
    expect(api.getState().snapshot).toBe(before);
  });

  it("notifies subscribers once per change", () => {
    const api = store();
    let calls = 0;
    const stop = api.subscribe(() => {
      calls += 1;
    });
    api.setView("done");
    api.setPane("board");
    stop();
    api.setView("all");
    expect(calls).toBe(2);
  });

  it("keeps the cursor inside the list", () => {
    const api = store();
    api.moveCursor(-5, 10);
    expect(api.getState().ui.cursor).toBe(0);
    api.moveCursor(50, 10);
    expect(api.getState().ui.cursor).toBe(9);
  });
});

it("all selectors, counts, inbox and board stay within the selected project", async () => {
  const { inboxRows, attentionCount } = await import("./inbox.js");
  const { selectedRows, cursorItems } = await import("./selectors.js");
  const api = store();
  const snapshot = api.getState().snapshot;
  api.getState().ui.repo = "";
  for (const repo of snapshot.repos) {
    api.open(must(snapshot.tasks[0]).id);
    const { stateFromSnapshot } = await import("@loom/protocol");
    const { toSnapshot } = await import("../fixtures/protocol.js");
    const { body, meta } = toSnapshot(snapshot);
    body.projects = [{ id: "project", repoId: repo.id }];
    api.applyProtocol(stateFromSnapshot(meta, body));
    expect(api.getState().ui.openTask).toBeNull();
    for (const view of [
      "all",
      "needs-you",
      "in-progress",
      "awaiting-approval",
      "done",
    ] as const) {
      api.setView(view);
      expect(
        selectedRows(api.getState()).every(
          (row) => row.task.repoId === repo.id,
        ),
      ).toBe(true);
      expect(viewCounts(snapshot, repo.id)[view]).toBe(
        rowsFor(snapshot, view, repo.id).length,
      );
      for (const pane of ["list", "board"] as const) {
        api.setPane(pane);
        expect(
          cursorItems(api.getState()).every(
            (item) => item.kind !== "row" || item.row.task.repoId === repo.id,
          ),
        ).toBe(true);
      }
    }
    expect(
      inboxRows(api.getState()).every((row) => row.task.repoId === repo.id),
    ).toBe(true);
    expect(attentionCount(api.getState())).toBe(
      snapshot.tasks
        .filter((task) => task.repoId === repo.id)
        .reduce((sum, task) => sum + task.attention.reasons.length, 0),
    );
  }
  expect(rowsFor(snapshot, "all", "all")).toEqual([]);
  expect(rowsFor(snapshot, "all", "")).toEqual([]);
});

it("live selection changes only when the coordinator publishes it", async () => {
  const { stateFromSnapshot } = await import("@loom/protocol");
  const { toSnapshot } = await import("../fixtures/protocol.js");
  const fixture = buildSnapshot(20);
  const { body, meta } = toSnapshot(fixture);
  const api = createStore(fixture);
  api.applyProtocol(stateFromSnapshot(meta, body));
  const next = must(fixture.repos[1]);
  const commands: unknown[] = [];
  api.setSender(async (command) => {
    commands.push(command);
    return { ok: true, result: { kind: "repo_selected", repoId: next.id } };
  });
  const pr = must(fixture.pullRequests[0]);
  api.openPullRequest({ repoId: pr.repoId, number: pr.number });
  await api.setRepo(next.id);
  expect(api.getState().ui.openPr).not.toBeNull();
  expect(commands).toEqual([{ kind: "select_repo", repoId: next.id }]);
  expect(api.getState().ui.repo).toBe(body.projects[0]?.repoId);
  body.projects = [{ id: "project", repoId: next.id }];
  api.applyProtocol(stateFromSnapshot(meta, body));
  expect(api.getState().ui.repo).toBe(next.id);
  expect(api.getState().ui.openPr).toBeNull();
  const secondWindow = createStore(fixture);
  secondWindow.applyProtocol(stateFromSnapshot(meta, body));
  expect(secondWindow.getState().ui.repo).toBe(next.id);
});

it("a dropped card moves before the coordinator answers, and a refusal puts it back", async () => {
  const { stateFromSnapshot } = await import("@loom/protocol");
  const { toSnapshot } = await import("../fixtures/protocol.js");
  const fixture = buildSnapshot(20);
  const { body, meta } = toSnapshot(fixture);
  const api = createStore(fixture);
  api.applyProtocol(stateFromSnapshot(meta, body));
  const task = must(
    api.getState().snapshot.tasks.find((t) => t.stage === "backlog"),
  );
  const stageOf = () =>
    api.getState().snapshot.tasks.find((t) => t.id === task.id)?.stage;

  let answer: (
    outcome: Awaited<ReturnType<Parameters<typeof api.setSender>[0]>>,
  ) => void = () => {};
  api.setSender(() => new Promise((resolve) => (answer = resolve)));
  api.moveTask(task.id, "todo");
  expect(stageOf()).toBe("todo");
  // An unrelated patch of the same task version keeps the move on screen.
  api.applyProtocol(stateFromSnapshot(meta, body));
  expect(stageOf()).toBe("todo");
  answer({
    ok: false,
    error: { code: "wrong_stage", message: "move is not allowed", details: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stageOf()).toBe("backlog");
  expect(api.getState().ui.toast).toContain("move is not allowed");

  // Accepted: the card stays moved until the coordinator's newer version replaces it.
  api.setSender(async () => ({
    ok: true,
    result: { kind: "human", inputId: "input-move" as never },
  }));
  api.moveTask(task.id, "todo");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stageOf()).toBe("todo");
  body.tasks = body.tasks.map((t) =>
    t.id === task.id ? { ...t, stage: "planning", version: t.version + 1 } : t,
  );
  api.applyProtocol(stateFromSnapshot(meta, body));
  expect(stageOf()).toBe("planning");
});

it("starts empty and refuses simulated stage transitions", async () => {
  const { createStore } = await import("./store.js");
  expect(createStore().getState().snapshot.tasks).toEqual([]);
  const api = createStore(buildSnapshot());
  const before = api.getState().snapshot;
  const task = must(before.tasks[0]);
  api.moveTask(task.id, "in_review");
  expect(api.getState().snapshot).toBe(before);
  expect(api.getState().ui.toast).toBe("The coordinator controls this stage.");
  const result = await api.command({
    kind: "human",
    taskId: task.id,
    command: { type: "retry" },
  });
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(api.getState().snapshot).toBe(before);
});

it("protocol updates retain a selected task or header by identity", async () => {
  const { stateFromSnapshot } = await import("@loom/protocol");
  const { toSnapshot } = await import("../fixtures/protocol.js");
  const { cursorItems, listItemKey } = await import("./selectors.js");
  const api = store();
  const wire = toSnapshot(api.getState().snapshot);
  api.applyProtocol(stateFromSnapshot(wire.meta, wire.body));
  for (const kind of ["row", "header"] as const) {
    const items = cursorItems(api.getState());
    expect(cursorItems(api.getState())).toBe(items);
    const index = items.findLastIndex((item) => item.kind === kind);
    api.setCursor(index);
    const selected = listItemKey(items[index]!);
    const first = wire.body.tasks[0]!;
    wire.body.tasks = [
      ...wire.body.tasks,
      { ...first, id: `extra-${kind}` as typeof first.id, stage: "backlog" },
    ];
    api.applyProtocol(stateFromSnapshot(wire.meta, wire.body));
    expect(
      listItemKey(cursorItems(api.getState())[api.getState().ui.cursor!]!),
    ).toBe(selected);
  }
});
