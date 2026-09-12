import type { TaskId } from "@loom/core";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { groupRows, rowsFor, sortRows, viewCounts } from "./selectors.js";
import { createStore, matchesView } from "./store.js";

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
    const counts = viewCounts(snapshot, "all");
    for (const view of [
      "all",
      "needs-you",
      "in-progress",
      "awaiting-approval",
      "done",
    ] as const) {
      expect(counts[view]).toBe(
        snapshot.tasks.filter((task) => matchesView(task, view)).length,
      );
    }
  });

  it("filters by repository", () => {
    const snapshot = buildSnapshot();
    const repo = must(snapshot.repos[1]);
    const rows = rowsFor(snapshot, "all", repo.id, "");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.task.repoId).toBe(repo.id);
  });

  it("searches on id and title", () => {
    const snapshot = buildSnapshot();
    const rows = rowsFor(snapshot, "all", "all", "worktree");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(`${row.task.id} ${row.task.title}`.toLowerCase()).toContain(
        "worktree",
      );
    }
  });
});

describe("the list", () => {
  it("sorts by age and reverses", () => {
    const rows = rowsFor(buildSnapshot(), "all", "all", "");
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
      rowsFor(buildSnapshot(), "all", "all", ""),
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
