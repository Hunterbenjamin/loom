import type { Snapshot } from "../store/snapshot.js";
import { createStore } from "../store/store.js";
import { buildSnapshot } from "./index.js";
import { buildPullRequestDetails } from "./pull-requests.js";

/** Inject presentation data for component/selector tests. Commands still require a test sender. */
export function createFixtureStore(
  snapshot: Snapshot = buildSnapshot(),
  instance = "test",
) {
  const store = createStore(snapshot, instance);
  const state = store.getState();
  state.ui.repo = snapshot.repos[0]?.id ?? "";
  state.pullRequestDetails = buildPullRequestDetails(snapshot.pullRequests);
  store.setConnection("connected");
  return store;
}
