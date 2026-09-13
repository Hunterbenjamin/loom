// One in-memory snapshot, one UI state, one subscription. Everything a panel renders comes
// from here; nothing reads disk or the network during an interaction.

import type {
  AttentionReason,
  Finding,
  FindingStatus,
  RunId,
  Stage,
  Task,
  TaskId,
} from "@loom/core";
import type {
  AckOutcome,
  ClientState,
  Command,
  Entities,
  LeadState,
  OperatorState,
  PaneIdentity,
  PaneView,
  PatchFrame,
  RunTarget,
  TaskInbox,
} from "@loom/protocol";
import { command as commandSchema } from "@loom/protocol";
import { inputId, minutesBefore, transitionId } from "../fixtures/ids.js";
import {
  buildSnapshot,
  type Comment,
  type Snapshot,
} from "../fixtures/index.js";
import { projectSnapshot } from "../live/snapshot.js";
import { createPaneTransitionDetector } from "./pane-transitions.js";

export type ViewId =
  | "all"
  | "needs-you"
  | "in-progress"
  | "awaiting-approval"
  | "done";
export type Pane = "list" | "board";
export type TabId = "activity" | "plan" | "agents" | "terminal" | "review";
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
  chimeMuted: boolean;
  stagePicker: boolean;
  toast: string | null;
  openRun: RunId | null;
  openReason: AttentionReason | null;
}

export interface State {
  snapshot: Snapshot;
  ui: UiState;
  live: boolean;
  connection: string;
  inbox: TaskInbox[];
  panes: PaneView[];
  panesUnavailable: boolean;
  runTargets: RunTarget[];
  lead: LeadState;
  operator: OperatorState | null;
  notes: Entities["note"][];
  instance: string;
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
      return task.attention.reasons.length > 0;
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
  chimeMuted: false,
  stagePicker: false,
  toast: null,
  openRun: null,
  openReason: null,
};

/** The harness asks for a longer list with `?tasks=500`; the app itself never sets it. */
function taskCount(): number | undefined {
  if (typeof location === "undefined") return undefined;
  const value = Number(new URLSearchParams(location.search).get("tasks"));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export type Store = ReturnType<typeof createStore>;

export function createStore(
  snapshot: Snapshot = buildSnapshot(taskCount()),
  live = false,
  instance = live ? "unconfigured" : "fixtures",
) {
  const notificationClaims = new Set<string>();
  const paneTransitions = createPaneTransitionDetector();
  const transitionListeners = new Set<(pane: PaneView) => void>();
  let paneFocus:
    | (() => PaneIdentity | "main" | "operator" | undefined)
    | undefined;
  let state: State = {
    snapshot,
    ui: initialUi,
    live,
    connection: live ? "connecting" : "fixtures",
    inbox: [],
    operator: null,
    notes: [],
    panes: [],
    panesUnavailable: false,
    runTargets: [],
    instance,
    lead: { id: "lead", sessionId: null, status: live ? "stopped" : "idle" },
  };
  let send: ((command: Command) => Promise<AckOutcome>) | null = null;
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
    setSender(sender: (command: Command) => Promise<AckOutcome>) {
      send = sender;
    },
    async command(value: Command): Promise<AckOutcome> {
      const parsed = commandSchema.safeParse(value);
      const outcome: AckOutcome = !parsed.success
        ? {
            ok: false,
            error: {
              code: "invalid_input",
              message: "Check the command fields",
              details: [],
            },
          }
        : send
          ? await send(parsed.data)
          : {
              ok: false,
              error: {
                code: "unavailable",
                message: live
                  ? "Disconnected; command was not sent"
                  : "Fixture mode: commands are not sent",
                details: [],
              },
            };
      setUi({
        toast: outcome.ok
          ? outcome.result.kind === "human"
            ? `Queued by coordinator (${outcome.result.inputId}); watch Activity for the result.`
            : "Coordinator acknowledged the command."
          : `${outcome.error.code}: ${outcome.error.message}`,
      });
      return outcome;
    },
    subscribePaneTransitions(listener: (pane: PaneView) => void) {
      transitionListeners.add(listener);
      return () => {
        transitionListeners.delete(listener);
      };
    },
    registerPaneFocus(reader: NonNullable<typeof paneFocus>) {
      paneFocus = reader;
      return () => {
        if (paneFocus === reader) paneFocus = undefined;
      };
    },
    focusedPane() {
      return paneFocus?.();
    },
    toggleChimeMuted() {
      setUi({ chimeMuted: !state.ui.chimeMuted });
    },
    setConnection(connection: string) {
      if (connection !== "connected") paneTransitions.reset();
      state = { ...state, connection };
      emit();
    },
    applyProtocol(client: ClientState, patch?: PatchFrame) {
      const previous = state;
      const notices = [...client.collections.inbox.values()].flatMap((i) =>
        i.forHuman ? [i.forHuman.noteId] : [],
      );
      for (const note of client.collections.operator.get("operator")?.actions ??
        [])
        if (note.forHuman && !note.taskId) notices.push(note.id);
      for (const noteId of notices)
        if (send && !notificationClaims.has(noteId)) {
          notificationClaims.add(noteId);
          void send({ kind: "claim_notification", noteId })
            .then((outcome) => {
              if (
                outcome.ok &&
                outcome.result.kind === "notification" &&
                outcome.result.notice
              )
                globalThis.window?.loomHost?.notify?.(outcome.result.notice);
              else if (!outcome.ok) notificationClaims.delete(noteId);
            })
            .catch(() => notificationClaims.delete(noteId));
        }
      state = {
        ...state,
        snapshot: projectSnapshot(state.snapshot, client, patch),
        inbox:
          !patch || patch.changes.some((c) => c.collection === "inbox")
            ? [...client.collections.inbox.values()]
            : state.inbox,
        lead: client.collections.lead.get("lead") ?? state.lead,
        operator: client.collections.operator.get("operator") ?? null,
        notes:
          !patch || patch.changes.some((c) => c.collection === "note")
            ? [...client.collections.note.values()]
            : state.notes,
        panes:
          !patch || patch.changes.some((c) => c.collection === "pane")
            ? [...client.collections.pane.values()]
            : state.panes,
        panesUnavailable:
          client.collections.pane_inventory.get("panes")?.unavailable ?? false,
        runTargets:
          !patch || patch.changes.some((c) => c.collection === "run_target")
            ? [...client.collections.run_target.values()]
            : state.runTargets,
      };
      const transitions =
        previous.panes !== state.panes ||
        previous.snapshot.runs !== state.snapshot.runs ||
        previous.panesUnavailable !== state.panesUnavailable
          ? paneTransitions.observe(
              state.panes,
              state.snapshot.runs,
              state.panesUnavailable,
            )
          : [];
      emit();
      for (const pane of transitions)
        for (const listener of transitionListeners) listener(pane);
    },
    openAttention(
      task: TaskId,
      reason: AttentionReason,
      tab: TabId,
      run: RunId | null,
    ) {
      setUi({ openTask: task, openReason: reason, openRun: run, tab });
    },
    setRun(openRun: RunId | null) {
      setUi({ openRun });
    },
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
      setUi({
        openTask: task,
        openRun: null,
        openReason: null,
        tab: task ? state.ui.tab : "activity",
      });
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
      if (live) {
        if (to !== "backlog" && to !== "todo") {
          api.toast("The coordinator controls this stage.");
          return;
        }
        void api.command({
          kind: "human",
          taskId: id,
          command: { type: "move", to },
        });
        return;
      }
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
      if (live) {
        api.toast("This action is not available in the live Tracker yet.");
        return;
      }
      setSnapshot({
        ...state.snapshot,
        findings: state.snapshot.findings.map(
          (f): Finding =>
            f.id === id ? { ...f, status, updatedAt: minutesBefore(0) } : f,
        ),
      });
    },

    addComment(findingId: string, body: string) {
      if (live) {
        api.toast("This action is not available in the live Tracker yet.");
        return;
      }
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
      if (live) {
        api.toast("This action is not available in the live Tracker yet.");
        return;
      }
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
      if (live) {
        api.toast("This action is not available in the live Tracker yet.");
        return;
      }
      const repoId =
        repo === "all" ? (state.snapshot.repos[0]?.id ?? "") : repo;
      const at = minutesBefore(0);
      const id = `LOOM-${state.snapshot.tasks.length + 101}` as TaskId;
      const task: Task = {
        id,
        repoId: repoId as Task["repoId"],
        title,
        description: "",
        summary: null,
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
        size: "normal",
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
