import type { TaskId } from "@loom/core";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { groupRows, rowsFor, sortRows, viewCounts } from "./selectors.js";
import { createStore } from "./store.js";

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
  it("sorts by age and reverses", () => {
    const rows = rowsFor(buildSnapshot(), "all", "repo-loom");
    const oldest = sortRows(rows, "age", false);
    const newest = sortRows(rows, "age", true);
    expect(must(oldest[0]).ageMinutes).toBeGreaterThanOrEqual(
      must(oldest.at(-1)).ageMinutes,
    );
    expect(must(newest[0]).ageMinutes).toBeLessThanOrEqual(
      must(newest.at(-1)).ageMinutes,
    );
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
  it("moves a task and writes the transition the coordinator would have written", () => {
    const api = store();
    const task = must(api.getState().snapshot.tasks[0]);
    const before = api.getState().snapshot.transitions.length;
    api.moveTask(task.id, "in_review");
    const after = api.getState().snapshot;
    expect(
      after.tasks.find((candidate) => candidate.id === task.id)?.stage,
    ).toBe("in_review");
    expect(after.transitions).toHaveLength(before + 1);
    const last = must(after.transitions.at(-1));
    expect(last.from).toBe(task.stage);
    expect(last.to).toBe("in_review");
    expect(last.trigger.kind).toBe("human");
  });

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

  it("toggles viewed state per task and file", () => {
    const api = store();
    const task = must(api.getState().snapshot.tasks[0]);
    const path = must(api.getState().snapshot.patch.files[0]).path;
    api.toggleViewed(task.id, path);
    expect(api.getState().snapshot.viewedFiles[task.id]).toContain(path);
    api.toggleViewed(task.id, path);
    expect(api.getState().snapshot.viewedFiles[task.id]).not.toContain(path);
  });

  it("adds a comment to a finding and refuses an empty one", () => {
    const api = store();
    const finding = must(api.getState().snapshot.findings[0]);
    const before = api.getState().snapshot.comments.length;
    api.addComment(finding.id, "   ");
    expect(api.getState().snapshot.comments).toHaveLength(before);
    api.addComment(finding.id, " looks right ");
    const added = must(api.getState().snapshot.comments.at(-1));
    expect(added.body).toBe("looks right");
    expect(added.findingId).toBe(finding.id);
  });

  it("keeps the cursor inside the list", () => {
    const api = store();
    api.moveCursor(-5, 10);
    expect(api.getState().ui.cursor).toBe(0);
    api.moveCursor(50, 10);
    expect(api.getState().ui.cursor).toBe(9);
  });

  it("creates a task in the backlog and opens it", () => {
    const api = store();
    api.createTask("Try a thing", "all");
    const state = api.getState();
    expect(must(state.snapshot.tasks[0]).title).toBe("Try a thing");
    expect(must(state.snapshot.tasks[0]).stage).toBe("backlog");
    expect(state.ui.openTask).toBe(must(state.snapshot.tasks[0]).id as TaskId);
  });
});

it("all selectors, counts, inbox and board stay within the selected project", async () => {
  const { inboxRows, attentionCount } = await import("./inbox.js");
  const { selectedRows, cursorRows } = await import("./selectors.js");
  const api = store();
  const snapshot = api.getState().snapshot;
  for (const repo of snapshot.repos) {
    api.open(must(snapshot.tasks[0]).id);
    await api.setRepo(repo.id);
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
          cursorRows(api.getState()).every(
            (row) => row.task.repoId === repo.id,
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
  const api = createStore(fixture, true);
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
  const secondWindow = createStore(fixture, true);
  secondWindow.applyProtocol(stateFromSnapshot(meta, body));
  expect(secondWindow.getState().ui.repo).toBe(next.id);
});

it("a dropped card moves before the coordinator answers, and a refusal puts it back", async () => {
  const { stateFromSnapshot } = await import("@loom/protocol");
  const { toSnapshot } = await import("../fixtures/protocol.js");
  const fixture = buildSnapshot(20);
  const { body, meta } = toSnapshot(fixture);
  const api = createStore(fixture, true);
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
