import type { PullRequestRow, Subscription } from "@loom/protocol";
import type { State } from "./store.js";

export function selectedPullRequests(state: State): PullRequestRow[] {
  const { repo, prState, prQuery } = state.ui;
  const needle = prQuery.trim().toLowerCase();
  return state.snapshot.pullRequests
    .filter(
      (pr) =>
        (repo === "all" || pr.repoId === repo) &&
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
  if (!state.ui.trackerVisible) return [];
  const detail: Subscription[] = state.ui.openPr
    ? [{ kind: "pull_request", ...state.ui.openPr }]
    : [];
  if (state.ui.view !== "pull-requests") return detail;
  return [
    ...detail,
    ...state.snapshot.repos
      .filter((repo) => state.ui.repo === "all" || repo.id === state.ui.repo)
      .flatMap((repo): Subscription[] =>
        (state.ui.prState === "open"
          ? ["open" as const]
          : ["open" as const, state.ui.prState]
        ).map((status) => ({
          kind: "pull_requests",
          repoId: repo.id,
          state: status,
        })),
      ),
  ];
}
