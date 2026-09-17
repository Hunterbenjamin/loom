import type {
  PullRequestDetailRow,
  PullRequestRow,
  Subscription,
} from "@loom/protocol";
import { pullRequestKey } from "@loom/protocol";
import { issuePrNumbers } from "./detail-selection.js";
import { memo1 } from "./memo.js";
import {
  indexSectionItems,
  retainedCursor,
  type SectionItem,
} from "./section-list.js";
import type { State, StoreContext } from "./store.js";
import type { UiState } from "./ui-state.js";

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

export type ReviewSection =
  | "ready"
  | "attention"
  | "waiting"
  | "created"
  | "completed";
export const REVIEW_SECTIONS: { id: ReviewSection; label: string }[] = [
  { id: "ready", label: "Ready to merge" },
  { id: "attention", label: "Needs attention" },
  { id: "waiting", label: "Waiting" },
  { id: "created", label: "Created by you" },
  { id: "completed", label: "Completed" },
];

function reviewReady(pr: PullRequestRow): boolean {
  return (
    mergeDisabledReason(pr) === null &&
    pr.review !== "changes_requested" &&
    !pr.reviewRequired &&
    !pr.viewerReviewRequested
  );
}

export function reviewNeedsHuman(pr: PullRequestRow): boolean {
  return (
    pr.state === "open" &&
    (reviewReady(pr) ||
      pr.viewerReviewRequested ||
      (pr.viewerDidAuthor &&
        (pr.checks === "failure" ||
          pr.mergeable === "conflicting" ||
          pr.review === "changes_requested")))
  );
}

function sectionFor(
  pr: PullRequestRow,
  tab: State["ui"]["prTab"],
): ReviewSection | null {
  if (tab === "created" && !pr.viewerDidAuthor) return null;
  if (pr.state !== "open") return "completed";
  if (tab === "created") return "created";
  if (reviewReady(pr)) return "ready";
  if (!pr.viewerDidAuthor && !pr.viewerReviewRequested) return null;
  if (
    pr.checks === "failure" ||
    pr.mergeable === "conflicting" ||
    pr.review === "changes_requested"
  )
    return "attention";
  if (pr.checks === "pending" || pr.reviewRequired || pr.viewerReviewRequested)
    return "waiting";
  return pr.viewerDidAuthor ? "created" : "waiting";
}

export function reviewGroups(state: {
  ui: Pick<UiState, "repo" | "prTab" | "prSections" | "prCompletedCount">;
  snapshot: Pick<State["snapshot"], "pullRequests">;
}) {
  const { repo, prTab, prSections, prCompletedCount } = state.ui;
  const groups = REVIEW_SECTIONS.map(({ id, label }) => ({
    id,
    label,
    collapsed: prSections[id] ?? id === "completed",
    rows: [] as PullRequestRow[],
    count: 0,
    remaining: 0,
  }));
  for (const pr of state.snapshot.pullRequests) {
    if (pr.repoId !== repo) continue;
    const group = groups.find((g) => g.id === sectionFor(pr, prTab));
    group?.rows.push(pr);
  }
  for (const group of groups) {
    group.rows.sort(
      (a, b) =>
        (group.id === "completed"
          ? Date.parse(b.completedAt ?? b.updatedAt) -
            Date.parse(a.completedAt ?? a.updatedAt)
          : Date.parse(b.createdAt) - Date.parse(a.createdAt)) ||
        b.number - a.number,
    );
    group.count = group.rows.length;
    if (group.id === "completed") {
      group.remaining = Math.max(0, group.count - prCompletedCount);
      group.rows = group.rows.slice(0, prCompletedCount);
    }
    if (group.collapsed) group.rows = [];
  }
  return groups;
}

export type ReviewItem = SectionItem<
  PullRequestRow,
  ReviewSection,
  "completed"
>;
const reviewItems = memo1(
  (
    pullRequests: PullRequestRow[],
    repo: string,
    prTab: UiState["prTab"],
    prSections: UiState["prSections"],
    prCompletedCount: number,
  ): ReviewItem[] => {
    const groups = reviewGroups({
      snapshot: { pullRequests },
      ui: { repo, prTab, prSections, prCompletedCount },
    });
    const items: ReviewItem[] = [];
    for (const group of groups) {
      if (!group.count && group.id !== "completed") continue;
      items.push({
        kind: "header",
        key: `header-${group.id}`,
        section: group.id,
        count: group.count,
        collapsed: group.collapsed,
      });
      for (const row of group.rows)
        items.push({
          kind: "row",
          key: pullRequestKey(row.repoId, row.number),
          section: group.id,
          row,
        });
      if (!group.collapsed && group.remaining)
        items.push({
          kind: "load-more",
          key: "load-more-completed",
          section: "completed",
          count: Math.min(20, group.remaining),
        });
    }
    return indexSectionItems(items);
  },
);

export function selectedReviewItems(
  state: Pick<State, "ui" | "snapshot">,
): ReviewItem[] {
  const { repo, prTab, prSections, prCompletedCount } = state.ui;
  return reviewItems(
    state.snapshot.pullRequests,
    repo,
    prTab,
    prSections,
    prCompletedCount,
  );
}

/** Detail navigation uses the same visible ordering, without the header stops. */
export function selectedPullRequests(state: State): PullRequestRow[] {
  return selectedReviewItems(state).flatMap((item) =>
    item.kind === "row" ? [item.row] : [],
  );
}

export function reviewAgentWorking(state: State, pr: PullRequestRow): boolean {
  return (
    pr.taskId !== null &&
    state.snapshot.runs.some(
      (run) => run.taskId === pr.taskId && run.status === "working",
    )
  );
}

/** The selected repository stays subscribed for the bottom bar in either window mode. */
export function pullRequestSubscriptions(state: State): Subscription[] {
  const task = state.snapshot.tasks.find(
    (item) => item.id === state.ui.openTask,
  );
  const number = task ? issuePrNumbers(state, task)[0] : undefined;
  const selection =
    state.ui.openPr ??
    (task && number ? { repoId: task.repoId, number } : null);
  const detail: Subscription[] =
    state.ui.trackerVisible && selection
      ? [{ kind: "pull_request", ...selection }]
      : [];
  return [
    ...detail,
    ...state.snapshot.repos
      .filter((repo) => repo.id === state.ui.repo)
      .flatMap((repo): Subscription[] =>
        (!state.ui.trackerVisible || state.ui.view !== "pull-requests"
          ? ["open" as const]
          : ["open" as const, "merged" as const, "closed" as const]
        ).map((status) => ({
          kind: "pull_requests",
          repoId: repo.id,
          state: status,
        })),
      ),
  ];
}

export function pullRequestActions(ctx: StoreContext) {
  const updateSections = (patch: Partial<UiState>) => {
    const state = ctx.get();
    const selected = selectedReviewItems(state)[state.ui.prCursor ?? -1];
    const next = { ...state, ui: { ...state.ui, ...patch } };
    ctx.setUi({
      ...patch,
      prCursor: retainedCursor(selectedReviewItems(next), selected),
    });
  };
  return {
    setPrTab(prTab: UiState["prTab"]) {
      ctx.setUi({ prTab, prCursor: null });
    },
    togglePrSection(section: ReviewSection) {
      const { ui } = ctx.get();
      const collapsed = ui.prSections[section] ?? section === "completed";
      updateSections({
        prSections: { ...ui.prSections, [section]: !collapsed },
      });
    },
    loadMoreCompletedPrs() {
      updateSections({ prCompletedCount: ctx.get().ui.prCompletedCount + 20 });
    },
    openPullRequest(openPr: UiState["openPr"]) {
      ctx.setUi({
        openPr,
        openTask: null,
        openRun: null,
        openReason: null,
        tab: "overview",
      });
    },
    setPrCursor(prCursor: number | null) {
      ctx.setUi({ prCursor });
    },
  };
}
