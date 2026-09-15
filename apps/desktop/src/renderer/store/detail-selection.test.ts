import { expect, test } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { buildPullRequestDetails } from "../fixtures/pull-requests.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { issuePrNumbers, selectedDetailTask } from "./detail-selection.js";
import { pullRequestSubscriptions } from "./pull-requests.js";

test("issue selection subscribes to its PR and Review selection resolves the same task", () => {
  const snapshot = buildSnapshot();
  const pr = snapshot.pullRequests.find((pr) => pr.taskId);
  const task = snapshot.tasks.find((task) => task.id === pr?.taskId);
  if (!pr || !task) throw new Error("Missing linked PR");
  const store = createStore(snapshot);
  store.setTrackerVisible(true);
  store.open(task.id);
  expect(issuePrNumbers(store.getState(), task)).toContain(pr.number);
  expect(pullRequestSubscriptions(store.getState())).toContainEqual({
    kind: "pull_request",
    repoId: pr.repoId,
    number: pr.number,
  });
  store.openPullRequest({ repoId: pr.repoId, number: pr.number });
  expect(selectedDetailTask(store.getState())?.id).toBe(task.id);
  const row = buildPullRequestDetails([pr])[0];
  if (!row) throw new Error("Missing detail");
  row.taskId = null;
  store.getState().pullRequestDetails = [row];
  expect(selectedDetailTask(store.getState())).toBeUndefined();
  store.openPullRequest(null);
  expect(
    pullRequestSubscriptions(store.getState()).some(
      (scope) => scope.kind === "pull_request",
    ),
  ).toBe(false);
});
