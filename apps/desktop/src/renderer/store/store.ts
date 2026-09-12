// One in-memory snapshot, one UI state, one subscription. Everything a panel renders comes
// from here; nothing reads disk or the network during an interaction.

import type { Finding, FindingStatus, Stage, Task, TaskId } from "@loom/core";
import { inputId, minutesBefore, transitionId } from "../fixtures/ids.js";
import {
  buildSnapshot,
  type Comment,
  type Snapshot,
} from "../fixtures/index.js";

export type ViewId =
  | "all"
  | "needs-you"
  | "in-progress"
  | "awaiting-approval"
  | "done";
export type Pane = "list" | "board";
export type TabId =
  | "activity"
  | "plan"
  | "agents"
  | "terminal"
  | "changes"
  | "review";
export type SortKey =
  | "stage"
  | "title"
  | "attention"
  | "provider"
  | "round"
  | "age";
export type Theme = "dark" | "light";

export interface UiState {
  view: ViewId;
  pane: Pane;
  /** Repo filter; `all` means every repo. */
  repo: string;
  cursor: number;
  openTask: TaskId | null;
  tab: TabId;
  sort: SortKey;
  descending: boolean;
  query: string;
  searching: boolean;
  theme: Theme;
  palette: boolean;
  stagePicker: boolean;
  toast: string | null;
}

export interface State {
  snapshot: Snapshot;
  ui: UiState;
}

export const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: "all", label: "All tasks", hint: "Everything in the selected repos" },
  {
    id: "needs-you",
    label: "Needs you",
    hint: "Attention flags, blocked and failed",
  },
  { id: "in-progress", label: "In progress", hint: "Planning through review" },
  {
    id: "awaiting-approval",
    label: "Awaiting approval",
    hint: "Plan and merge approvals",
  },
  { id: "done", label: "Done", hint: "Merged or canceled" },
];

const IN_PROGRESS: Stage[] = [
  "planning",
  "in_progress",
  "in_review",
  "merging",
];

export function matchesView(task: Task, view: ViewId): boolean {
  switch (view) {
    case "all":
      return true;
    case "needs-you":
      return (
        task.attention.reasons.length > 0 ||
        task.blocked !== null ||
        task.failed !== null
      );
    case "in-progress":
      return IN_PROGRESS.includes(task.stage);
    case "awaiting-approval":
      return (
        task.stage === "plan_approval" || task.stage === "awaiting_approval"
      );
    case "done":
      return task.stage === "done" || task.stage === "canceled";
  }
}

const initialUi: UiState = {
  view: "all",
  pane: "list",
  repo: "all",
  cursor: 0,
  openTask: null,
  tab: "activity",
  sort: "stage",
  descending: false,
  query: "",
  searching: false,
  theme: "dark",
  palette: false,
  stagePicker: false,
  toast: null,
};

/** The harness asks for a longer list with `?tasks=500`; the app itself never sets it. */
function taskCount(): number | undefined {
  if (typeof location === "undefined") return undefined;
  const value = Number(new URLSearchParams(location.search).get("tasks"));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export type Store = ReturnType<typeof createStore>;

export function createStore(snapshot: Snapshot = buildSnapshot(taskCount())) {
  let state: State = { snapshot, ui: initialUi };
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setUi = (patch: Partial<UiState>) => {
    state = { ...state, ui: { ...state.ui, ...patch } };
    emit();
  };

  const setSnapshot = (next: Snapshot) => {
    state = { ...state, snapshot: next };
    emit();
  };

  const api = {
    getState: (): State => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setView(view: ViewId) {
      setUi({ view, cursor: 0, openTask: null });
    },
    setPane(pane: Pane) {
      setUi({ pane });
    },
    setRepo(repo: string) {
      setUi({ repo, cursor: 0 });
    },
    setSort(sort: SortKey) {
      setUi(
        state.ui.sort === sort
          ? { descending: !state.ui.descending }
          : { sort, descending: sort === "age" },
      );
    },
    setCursor(cursor: number) {
      setUi({ cursor });
    },
    moveCursor(delta: number, length: number) {
      if (length === 0) return;
      const cursor = Math.max(0, Math.min(length - 1, state.ui.cursor + delta));
      setUi({ cursor });
    },
    open(task: TaskId | null) {
      setUi({ openTask: task, tab: task ? state.ui.tab : "activity" });
    },
    setTab(tab: TabId) {
      setUi({ tab });
    },
    setQuery(query: string) {
      setUi({ query, cursor: 0 });
    },
    setSearching(searching: boolean) {
      setUi({ searching, query: searching ? state.ui.query : "", cursor: 0 });
    },
    setTheme(theme: Theme) {
      setUi({ theme });
    },
    toggleTheme() {
      setUi({ theme: state.ui.theme === "dark" ? "light" : "dark" });
    },
    setPalette(palette: boolean) {
      setUi({ palette });
    },
    setStagePicker(stagePicker: boolean) {
      setUi({ stagePicker });
    },
    toast(toast: string | null) {
      setUi({ toast });
    },

    /**
     * Moving a card is the one write the UI is allowed to make in the real app, and even then
     * it is a request the coordinator validates. Here it just edits the snapshot, and appends
     * the transition the coordinator would have written, so the Activity tab stays truthful.
     */
    moveTask(id: TaskId, to: Stage) {
      const task = state.snapshot.tasks.find((t) => t.id === id);
      if (!task || task.stage === to) return;
      const at = minutesBefore(0);
      setSnapshot({
        ...state.snapshot,
        tasks: state.snapshot.tasks.map((t) =>
          t.id === id
            ? {
                ...t,
                stage: to,
                stageEnteredAt: at,
                updatedAt: at,
                version: t.version + 1,
              }
            : t,
        ),
        transitions: [
          ...state.snapshot.transitions,
          {
            id: transitionId(`${id}-tm${state.snapshot.transitions.length}`),
            taskId: id,
            at,
            from: task.stage,
            to,
            flags: {},
            trigger: {
              kind: "human",
              command: "move",
              inputId: inputId(`ui-${Date.now()}`),
            },
            reason: "Moved by hand in the window.",
            taskVersion: task.version + 1,
          },
        ],
      });
    },

    setFindingStatus(id: string, status: FindingStatus) {
      setSnapshot({
        ...state.snapshot,
        findings: state.snapshot.findings.map(
          (f): Finding =>
            f.id === id ? { ...f, status, updatedAt: minutesBefore(0) } : f,
        ),
      });
    },

    addComment(findingId: string, body: string) {
      if (body.trim() === "") return;
      const comment: Comment = {
        id: `c-${findingId}-${state.snapshot.comments.length}`,
        findingId,
        author: "you",
        body: body.trim(),
        at: minutesBefore(0),
      };
      setSnapshot({
        ...state.snapshot,
        comments: [...state.snapshot.comments, comment],
      });
    },

    toggleViewed(task: TaskId, path: string) {
      const current = state.snapshot.viewedFiles[task] ?? [];
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      setSnapshot({
        ...state.snapshot,
        viewedFiles: { ...state.snapshot.viewedFiles, [task]: next },
      });
    },

    createTask(title: string, repo: string) {
      const repoId =
        repo === "all" ? (state.snapshot.repos[0]?.id ?? "") : repo;
      const at = minutesBefore(0);
      const id = `LOOM-${state.snapshot.tasks.length + 101}` as TaskId;
      const task: Task = {
        id,
        repoId: repoId as Task["repoId"],
        title,
        description: "",
        stage: "backlog",
        stageEnteredAt: at,
        version: 1,
        blocked: null,
        failed: null,
        requirePlanApproval: true,
        reviewRound: 0,
        reviewRoundCap: 3,
        providers: state.snapshot.repos.find((r) => r.id === repoId)
          ?.defaultProviders ?? {
          planner: "codex",
          implementer: "claude",
          reviewer: "codex",
        },
        blockedBy: [],
        budgetMinutes: null,
        createdAt: at,
        updatedAt: at,
        worktreePath: null,
        branch: null,
        prNumber: null,
        attention: { reasons: [], reasonSince: {}, since: null },
      };
      setSnapshot({
        ...state.snapshot,
        tasks: [task, ...state.snapshot.tasks],
      });
      setUi({ cursor: 0, openTask: id });
    },
  };

  return api;
}
