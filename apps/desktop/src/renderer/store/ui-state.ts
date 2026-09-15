import type { AttentionReason, RunId, Stage, TaskId } from "@loom/core";
import type { ConversationTarget, PullRequestRow } from "@loom/protocol";
import { repoId as parseRepoId } from "@loom/protocol";
import type { Snapshot } from "../store/snapshot.js";
import type { ReviewSection } from "./pull-requests.js";
import type { State } from "./store.js";

export type ViewId =
  | "all"
  | "needs-you"
  | "in-progress"
  | "awaiting-approval"
  | "done"
  | "pull-requests"
  | "settings"
  | "briefs";
export type Pane = "list" | "board";
export type TabId = "overview" | "plan" | "diff" | "terminal";
export type SortKey =
  | "stage"
  | "title"
  | "attention"
  | "provider"
  | "round"
  | "time";
export type Theme = "dark" | "light";

/** Initial limit and each subsequent page for terminal list sections. */
export const LIST_PAGE_SIZE = 10;
export type ListSections = Partial<
  Record<Stage, { collapsed?: boolean; visibleCount?: number }>
>;

/** Canceled starts collapsed; every other section starts open until the human toggles it. */
export const sectionCollapsed = (sections: ListSections, stage: Stage) =>
  sections[stage]?.collapsed ?? stage === "canceled";

export interface UiState {
  /** Presentation only; owned by this window and never persisted. */
  listSections: ListSections;
  trackerVisible: boolean;
  prTab: "for-you" | "created";
  prSections: Partial<Record<ReviewSection, boolean>>;
  prCompletedCount: number;
  prQuery: string;
  prCursor: number | null;
  openPr: { repoId: PullRequestRow["repoId"]; number: number } | null;
  /** The brief open over the Daily brief list. */
  openBrief: string | null;
  view: ViewId;
  pane: Pane;
  /** Coordinator projection; empty only when no repository is registered. */
  repo: string;
  cursor: number | null;
  openTask: TaskId | null;
  tab: TabId;
  sort: SortKey;
  descending: boolean;
  theme: Theme;
  palette: boolean;
  chimeMuted: boolean;
  stagePicker: boolean;
  createIssue: boolean;
  /** Explicit selection should scroll even when it also reveals a collapsed section. */
  selectionVersion: number;
  toast: string | null;
  openRun: RunId | null;
  openReason: AttentionReason | null;
  chatTarget: ConversationTarget | null;
  chatView: "open" | "minimized" | "expanded";
}

export const initialUi: UiState = {
  listSections: {},
  trackerVisible: false,
  prTab: "for-you",
  prSections: {},
  prCompletedCount: 20,
  prQuery: "",
  prCursor: null,
  openPr: null,
  openBrief: null,
  view: "all",
  pane: "list",
  repo: "",
  cursor: null,
  openTask: null,
  tab: "overview",
  sort: "stage",
  descending: false,
  theme: "dark",
  palette: false,
  chimeMuted: false,
  stagePicker: false,
  createIssue: false,
  selectionVersion: 0,
  toast: null,
  openRun: null,
  openReason: null,
  chatTarget: null,
  chatView: "minimized",
};

export function createInitialState(
  snapshot: Snapshot,
  instance: string,
): State {
  return {
    snapshot,
    pullRequestLists: [],
    pullRequestDetails: [],
    ui: { ...initialUi },
    connection: "connecting",
    inbox: snapshot.inbox,
    notes: [],
    panes: [],
    panesUnavailable: false,
    readFinished: new Set<string>(),
    mainFinished: false,
    runTargets: [],
    instance,
    settings: [],
    conversations: [],
    conversationItems: [],
    lead: {
      id: parseRepoId.parse("lead"),
      sessionId: null,
      status: "stopped",
    },
  };
}

/** The Tracker's three destinations. Other view ids remain reachable by keyboard and palette. */
export const VIEWS: {
  id: Exclude<ViewId, "settings" | "briefs">;
  label: string;
  hint: string;
}[] = [
  {
    id: "needs-you",
    label: "Inbox",
    hint: "Everything that needs you: questions, approvals, blocked and failed",
  },
  {
    id: "all",
    label: "Issues",
    hint: "Every issue in the selected repository",
  },
  {
    id: "pull-requests",
    label: "Review",
    hint: "Pull requests to review and merge",
  },
];

export function revealStage(state: State, id: TaskId): State {
  const stage = state.snapshot.tasks.find((task) => task.id === id)?.stage;
  if (!stage || !sectionCollapsed(state.ui.listSections, stage)) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      listSections: {
        ...state.ui.listSections,
        [stage]: { ...state.ui.listSections[stage], collapsed: false },
      },
    },
  };
}

export function applyPendingSelection(
  state: State,
  id: TaskId,
  cursorFor: (state: State, id: TaskId) => number,
): { state: State; selected: boolean } {
  const revealed = revealStage(state, id);
  const cursor = cursorFor(revealed, id);
  if (cursor < 0) return { state: revealed, selected: false };
  return {
    state: {
      ...revealed,
      ui: {
        ...revealed.ui,
        cursor,
        selectionVersion: revealed.ui.selectionVersion + 1,
      },
    },
    selected: true,
  };
}

export function resetUiForRepo(ui: UiState, repo: string): UiState {
  return {
    ...ui,
    repo,
    cursor: null,
    prCursor: null,
    openTask: null,
    openPr: null,
    openRun: null,
    openReason: null,
    chatTarget:
      ui.chatTarget?.kind === "lead"
        ? { kind: "lead", repoId: parseRepoId.parse(repo) }
        : ui.chatTarget,
  };
}
