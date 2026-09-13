import type { PullRequestRow, Subscription } from "@loom/protocol";
import type { State } from "./store.js";

export function selectedPullRequests(state: State): PullRequestRow[] {
  const { repo, prState, prQuery } = state.ui;
  const needle = prQuery.trim().toLowerCase();
  return state.snapshot.pullRequests
    .filter(
      (pr) =>
        pr.repoId === repo &&
        pr.state === prState &&
        (!needle ||
          `#${pr.number} ${pr.title} ${pr.head} ${pr.base} ${pr.author ?? ""} ${pr.taskId ?? ""}`
            .toLowerCase()
            .includes(needle)),
    )
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.number - a.number ||
        a.repoId.localeCompare(b.repoId),
    );
}

/** Hidden Tracker views release their polls; open remains subscribed for the count. */
export function pullRequestSubscriptions(state: State): Subscription[] {
  if (!state.ui.trackerVisible || state.ui.view !== "pull-requests") return [];
  return state.snapshot.repos
    .filter((repo) => repo.id === state.ui.repo)
    .flatMap((repo): Subscription[] =>
      (state.ui.prState === "open"
        ? ["open" as const]
        : ["open" as const, state.ui.prState]
      ).map((status) => ({
        kind: "pull_requests",
        repoId: repo.id,
        state: status,
      })),
    );
}
