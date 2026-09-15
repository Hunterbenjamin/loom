import type { Store } from "@loom/store";
import { expect, test } from "vitest";
import { fixture } from "../../../packages/core/test/fixtures.js";
import { inspectTask } from "./inspect.js";

test("inspect task returns per-run, issue, and role token totals", () => {
  const { state } = fixture("in_progress");
  const planner = state.runs[0];
  const implementer = state.runs[1];
  if (!planner || !implementer) throw new Error("missing fixture runs");
  planner.tokenUsage = [
    {
      sessionId: "planner-session" as never,
      counts: { input: 10, cachedInput: 4, output: 3, reasoning: 1 },
      observedAt: state.task.updatedAt,
    },
  ];
  implementer.tokenUsage = [
    {
      sessionId: "implementer-session" as never,
      counts: { input: 20, cachedInput: 5, output: 7, reasoning: 2 },
      observedAt: state.task.updatedAt,
    },
  ];
  const store = {
    loadTaskState: () => state,
    repos: () => [],
    runs: () => state.runs,
    messages: () => [],
    mainMessages: { notes: () => [] },
    outbox: { recent: () => [] },
  } as unknown as Store;
  const inspection = inspectTask(store, state.task.id);
  expect(inspection.runs.map((run) => run.tokenUsage)).toEqual([
    { input: 10, cachedInput: 4, output: 3, reasoning: 1 },
    { input: 20, cachedInput: 5, output: 7, reasoning: 2 },
    null,
  ]);
  expect(inspection.task.tokenUsage).toEqual({
    total: { input: 30, cachedInput: 9, output: 10, reasoning: 3 },
    byRole: {
      planner: { input: 10, cachedInput: 4, output: 3, reasoning: 1 },
      implementer: { input: 20, cachedInput: 5, output: 7, reasoning: 2 },
      reviewer: { input: 0, cachedInput: 0, output: 0, reasoning: 0 },
    },
  });
});
