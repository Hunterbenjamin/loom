import type {
  PullRequestDetailRow,
  PullRequestRow,
  Subscription,
} from "@loom/protocol";
import type { State } from "./store.js";

/** Shared by the action bar, palette and repository readiness count. */
export function mergeDisabledReason(
  pr: Pick<PullRequestRow, "state" | "draft" | "mergeable" | "checks">,
): string | null {
  if (pr.state !== "open") return "The pull request is not open.";
  if (pr.draft) return "The pull request is a draft.";
  if (pr.mergeable === "conflicting") return "Resolve merge conflicts first.";
  if (pr.mergeable !== "mergeable") return "Mergeability is not yet known.";
  if (pr.checks === "failure") return "Checks have failed.";
  if (pr.checks === "pending") return "Checks are pending.";
  return null;
}

export function deleteDisabledReason(
  pr: PullRequestDetailRow["detail"],
): string | null {
  if (pr.state === "open") return "Close or merge the pull request first.";
  if (pr.branchExists === false) return "Branch deleted.";
  if (pr.branchExists === null) return "Branch existence is unknown.";
  if (pr.head === pr.base) return "The base branch cannot be deleted.";
  return null;
}

export function readyToMergeCount(state: State): number {
  return state.snapshot.pullRequests.filter(
    (pr) => pr.repoId === state.ui.repo && mergeDisabledReason(pr) === null,
  ).length;
}

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

/** The selected repository stays subscribed for the bottom bar in either window mode. */
export function pullRequestSubscriptions(state: State): Subscription[] {
  const detail: Subscription[] =
    state.ui.trackerVisible && state.ui.openPr
      ? [{ kind: "pull_request", ...state.ui.openPr }]
      : [];
  return [
    ...detail,
    ...state.snapshot.repos
      .filter((repo) => repo.id === state.ui.repo)
      .flatMap((repo): Subscription[] =>
        (!state.ui.trackerVisible ||
        state.ui.view !== "pull-requests" ||
        state.ui.prState === "open"
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
