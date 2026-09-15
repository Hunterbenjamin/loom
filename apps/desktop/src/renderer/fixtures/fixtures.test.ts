import { describe, expect, it } from "vitest";
import { STAGES } from "../ui/format.js";
import { buildSnapshot } from "./index.js";

const snapshot = buildSnapshot();

describe("the fixture snapshot", () => {
  it("covers every stage", () => {
    const stages = new Set(snapshot.tasks.map((task) => task.stage));
    for (const stage of STAGES) expect(stages).toContain(stage);
  });

  it("has about forty tasks with unique ids", () => {
    expect(snapshot.tasks).toHaveLength(42);
    expect(new Set(snapshot.tasks.map((task) => task.id)).size).toBe(42);
  });

  it("is deterministic, so measurements repeat", () => {
    expect(JSON.stringify(buildSnapshot())).toBe(JSON.stringify(snapshot));
  });

  it("includes the awkward cases the brief asks for", () => {
    const longest = snapshot.tasks.reduce((a, b) =>
      a.title.length > b.title.length ? a : b,
    );
    expect(longest.title.length).toBeGreaterThan(120);

    const runsPerTask = new Map<string, number>();
    for (const run of snapshot.runs) {
      runsPerTask.set(run.taskId, (runsPerTask.get(run.taskId) ?? 0) + 1);
    }
    expect(Math.max(...runsPerTask.values())).toBeGreaterThanOrEqual(3);

    expect(
      snapshot.runs.some(
        (run) => run.status === "blocked" && run.blockedOn === "permission",
      ),
    ).toBe(true);
    expect(snapshot.runs.some((run) => run.status === "failed")).toBe(true);
    expect(snapshot.tasks.some((task) => task.failed !== null)).toBe(true);
    expect(snapshot.tasks.some((task) => task.blocked !== null)).toBe(true);

    const findingsPerTask = new Map<string, number>();
    for (const finding of snapshot.findings) {
      findingsPerTask.set(
        finding.taskId,
        (findingsPerTask.get(finding.taskId) ?? 0) + 1,
      );
    }
    expect(Math.max(...findingsPerTask.values())).toBe(200);
  });

  it("maps findings as exact, moved, ambiguous and outdated", () => {
    const statuses = new Set(
      snapshot.findings.map((finding) => finding.location?.status),
    );
    expect(statuses).toContain("exact");
    expect(statuses).toContain("moved");
    expect(statuses).toContain("outdated");
    expect(statuses).toContain("ambiguous");
  });

  it("records a provider session id for every run, before launch", () => {
    for (const run of snapshot.runs) expect(run.sessionId).toBeTruthy();
  });

  it("keys worktrees, runs and tasks on the worktree path", () => {
    for (const worktree of snapshot.worktrees) {
      const task = snapshot.tasks.find(
        (candidate) => candidate.id === worktree.taskId,
      );
      expect(task?.worktreePath).toBe(worktree.path);
      for (const run of snapshot.runs.filter(
        (candidate) => candidate.taskId === task?.id,
      )) {
        expect(run.worktreePath).toBe(worktree.path);
      }
    }
  });

  it("builds a fifty-file patch with a rename and a binary file", () => {
    expect(
      snapshot.patch.files.filter((file) => file.status === "modified"),
    ).toHaveLength(50);
    expect(snapshot.patch.files.some((file) => file.status === "renamed")).toBe(
      true,
    );
    expect(snapshot.patch.files.some((file) => file.status === "binary")).toBe(
      true,
    );
    expect(snapshot.patch.text.startsWith("diff --git ")).toBe(true);
  });

  it("grows to the length the performance harness asks for", () => {
    expect(buildSnapshot(500).tasks).toHaveLength(500);
  });
});
