import type { Run } from "@loom/core";
import { describe, expect, test } from "vitest";
import { minutesBefore, runId, taskId } from "../fixtures/ids.js";
import { buildSnapshot, type Snapshot } from "../fixtures/index.js";
import { rowsFor } from "./selectors.js";

describe("rowsFor", () => {
  test("selects the most recent live run when multiple live runs exist", () => {
    const fixture = buildSnapshot();
    const task = fixture.tasks[0];
    if (!task) throw new Error("No task in fixture");

    // Get or create an older live run and a newer live run for the same task
    const olderRun = {
      ...fixture.runs[0],
      taskId: task.id,
      status: "working" as const,
      launchedAt: minutesBefore(10), // 10 minutes ago
    };
    const newerRun = {
      ...fixture.runs[1],
      taskId: task.id,
      status: "working" as const,
      launchedAt: minutesBefore(2), // 2 minutes ago
    };

    const testSnapshot = {
      ...fixture,
      runs: [olderRun, newerRun],
    } as Snapshot;

    const rows = rowsFor(testSnapshot, "all", "all", "");
    const taskRow = rows.find((r) => r.task.id === task.id);

    expect(taskRow).toBeDefined();
    if (!taskRow) throw new Error("Task row not found");

    // The selected run should be the newer one
    expect(taskRow.run?.launchedAt).toBe(newerRun.launchedAt);
    expect(taskRow.run?.id).toBe(newerRun.id);
  });

  test("falls back to the last run when no live runs exist", () => {
    const fixture = buildSnapshot();
    const testTaskId = taskId("test-task-no-live-runs");
    const testTask = {
      ...fixture.tasks[0],
      id: testTaskId,
    };

    // Create runs with no live status
    const olderEnded = {
      ...fixture.runs[0],
      id: runId("older-ended"),
      taskId: testTaskId,
      status: "ended" as const,
      endReason: "submitted" as const,
      launchedAt: minutesBefore(30),
    };
    const newerEnded = {
      ...fixture.runs[1],
      id: runId("newer-ended"),
      taskId: testTaskId,
      status: "ended" as const,
      endReason: "submitted" as const,
      launchedAt: minutesBefore(10),
    };

    // Newest first, so the order runs arrived in is not what decides.
    const testSnapshot = {
      ...fixture,
      tasks: [testTask],
      runs: [newerEnded, olderEnded],
    } as Snapshot;

    const rows = rowsFor(testSnapshot, "all", "all", "");
    const taskRow = rows.find((r) => r.task.id === testTaskId);

    expect(taskRow).toBeDefined();
    if (!taskRow) throw new Error("Task row not found");

    expect(taskRow.runs).toHaveLength(2);
    expect(taskRow.run?.id).toBe(newerEnded.id);
  });

  test("a launched managed run outranks an adopted external run with no launch time", () => {
    const fixture = buildSnapshot();
    const task = fixture.tasks[0];
    if (!task) throw new Error("No task in fixture");
    const external = {
      ...fixture.runs[0],
      id: runId("external-idle"),
      taskId: task.id,
      origin: "external" as const,
      status: "idle" as const,
      launchedAt: null,
      model: "",
    };
    const managed = {
      ...fixture.runs[1],
      id: runId("managed-working"),
      taskId: task.id,
      origin: "loom" as const,
      status: "working" as const,
      launchedAt: minutesBefore(3),
    };
    const pick = (runs: Run[]) =>
      rowsFor({ ...fixture, runs } as Snapshot, "all", "all", "").find(
        (r) => r.task.id === task.id,
      )?.run?.id;

    expect(pick([external, managed])).toBe(managed.id);
    expect(pick([managed, external])).toBe(managed.id);
  });

  test("with no launch times at all, the run that arrived last wins", () => {
    const fixture = buildSnapshot();
    const task = fixture.tasks[0];
    if (!task) throw new Error("No task in fixture");
    const first = {
      ...fixture.runs[0],
      id: runId("external-first"),
      taskId: task.id,
      origin: "external" as const,
      status: "working" as const,
      launchedAt: null,
    };
    const second = { ...first, id: runId("external-second") };
    const rows = rowsFor(
      { ...fixture, runs: [first, second] } as Snapshot,
      "all",
      "all",
      "",
    );
    expect(rows.find((r) => r.task.id === task.id)?.run?.id).toBe(second.id);
  });

  test("prefers live runs over non-live runs", () => {
    const fixture = buildSnapshot();
    const task = fixture.tasks[0];
    if (!task) throw new Error("No task in fixture");

    const idleRun = {
      ...fixture.runs[0],
      taskId: task.id,
      status: "idle" as const,
    };
    const workingRun = {
      ...fixture.runs[1],
      taskId: task.id,
      status: "working" as const,
      launchedAt: minutesBefore(5),
    };

    // Order: idle, working
    const testSnapshot = {
      ...fixture,
      runs: [idleRun, workingRun],
    } as Snapshot;

    const rows = rowsFor(testSnapshot, "all", "all", "");
    const taskRow = rows.find((r) => r.task.id === task.id);

    expect(taskRow).toBeDefined();
    if (!taskRow) throw new Error("Task row not found");

    // Should select the working run even though idle comes first
    expect(taskRow.run?.status).toBe("working");
  });

  test("returns null run when task has no runs", () => {
    const fixture = buildSnapshot();
    const task = fixture.tasks[0];
    if (!task) throw new Error("No task in fixture");

    const testSnapshot = {
      ...fixture,
      runs: [], // No runs
    };

    const rows = rowsFor(testSnapshot, "all", "all", "");
    const taskRow = rows.find((r) => r.task.id === task.id);

    expect(taskRow).toBeDefined();
    if (!taskRow) throw new Error("Task row not found");

    // Should have null run
    expect(taskRow.run).toBeNull();
  });
});
