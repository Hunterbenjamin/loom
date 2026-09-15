import type { Task } from "@loom/core";
import type { State } from "./store.js";

export function issuePrNumbers(state: State, task: Task): number[] {
  return [
    ...new Set([
      ...(task.prNumber ? [task.prNumber] : []),
      ...(state.inbox.find((row) => row.taskId === task.id)?.linkedPrNumbers ??
        []),
      ...state.snapshot.pullRequests
        .filter((row) => row.repoId === task.repoId && row.taskId === task.id)
        .map((row) => row.number),
    ]),
  ];
}

export function selectedDetailTask(state: State, selection = state.ui.openPr) {
  const row = selection
    ? state.pullRequestDetails.find(
        (row) =>
          row.repoId === selection.repoId && row.number === selection.number,
      )
    : undefined;
  const summary = selection
    ? state.snapshot.pullRequests.find(
        (row) =>
          row.repoId === selection.repoId && row.number === selection.number,
      )
    : undefined;
  const id = selection
    ? row
      ? row.taskId
      : summary?.taskId
    : state.ui.openTask;
  return state.snapshot.tasks.find((task) => task.id === id);
}
