import { repoId as parseRepoId } from "@loom/protocol";
import { sendWithMergeNotification } from "./merge-notification.js";
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
  PullRequestDetailRow,
  PullRequestRow,
  RunTarget,
  SettingsDocument,
  TaskInbox,
} from "@loom/protocol";
import { command as commandSchema } from "@loom/protocol";
import { inputId, minutesBefore, transitionId } from "../fixtures/ids.js";
import {
  buildSnapshot,
  type Comment,
  type Snapshot,
} from "../fixtures/index.js";
import { buildPullRequestDetails } from "../fixtures/pull-requests.js";
import { projectSnapshot } from "../live/snapshot.js";
import { paneIndicator } from "../workbench/selectors.js";
import { createPaneTransitionDetector } from "./pane-transitions.js";
import { selectedPullRequests } from "./pull-requests.js";
import { cursorRows } from "./selectors.js";

export type ViewId =
  | "all"
  | "needs-you"
  | "in-progress"
  | "awaiting-approval"
  | "done"
  | "pull-requests"
  | "settings";
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

/** Initial limit and each subsequent page for terminal list sections. */
export const LIST_PAGE_SIZE = 20;
export type ListSections = Partial<
  Record<Stage, { collapsed?: boolean; visibleCount?: number }>
>;

export interface UiState {
  /** Presentation only; owned by this window and never persisted. */
  listSections: ListSections;
  trackerVisible: boolean;
  prTab: "for-you" | "created";
  prSections: Partial<
    Record<import("./pull-requests.js").ReviewSection, boolean>
  >;
  prCompletedCount: number;
  prQuery: string;
  prCursor: number;
  openPr: { repoId: PullRequestRow["repoId"]; number: number } | null;
  view: ViewId;
  pane: Pane;
  /** Coordinator projection; empty only when no repository is registered. */
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
  createIssue: boolean;
  /** Explicit selection should scroll even when it also reveals a collapsed section. */
  selectionVersion: number;
  toast: string | null;
  openRun: RunId | null;
  openReason: AttentionReason | null;
}

export interface State {
  snapshot: Snapshot;
  pullRequestLists: Entities["pull_requests"][];
  pullRequestDetails: PullRequestDetailRow[];
  ui: UiState;
  live: boolean;
  connection: string;
  inbox: TaskInbox[];
  panes: PaneView[];
  panesUnavailable: boolean;
  /** Pane keys whose latest finish the human has looked at; in memory, per window. */
  readFinished: ReadonlySet<string>;
  /** Main finished a turn and the human has not looked at it since. */
  mainFinished: boolean;
  runTargets: RunTarget[];
  lead: LeadState;
  operator: OperatorState | null;
  notes: Entities["note"][];
  instance: string;
  settings: SettingsDocument[];
}

/** The Tracker's three destinations. Other view ids remain reachable by keyboard and palette. */
export const VIEWS: { id: ViewId; label: string; hint: string }[] = [
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

const IN_PROGRESS: Stage[] = [
  "planning",
  "in_progress",
  "in_review",
  "merging",
];

export function matchesView(task: Task, view: ViewId): boolean {
  switch (view) {
    case "settings":
    case "pull-requests":
      return false;
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
  listSections: {},
  trackerVisible: false,
  prTab: "for-you",
  prSections: {},
  prCompletedCount: 20,
  prQuery: "",
  prCursor: 0,
  openPr: null,
  view: "all",
  pane: "list",
  repo: "",
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
  createIssue: false,
  selectionVersion: 0,
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
  let pendingSelection: TaskId | null = null;
  const paneTransitions = createPaneTransitionDetector();
  const transitionListeners = new Set<(pane: PaneView) => void>();
  let paneFocus:
    | (() => PaneIdentity | "main" | "operator" | undefined)
    | undefined;
  let state: State = {
    snapshot,
    pullRequestLists: [],
    pullRequestDetails: live
      ? []
      : buildPullRequestDetails(snapshot.pullRequests),
    ui: { ...initialUi, repo: live ? "" : (snapshot.repos[0]?.id ?? "") },
    live,
    connection: live ? "connecting" : "fixtures",
    inbox: [],
    operator: null,
    notes: [],
    panes: [],
    panesUnavailable: false,
    readFinished: new Set<string>(),
    mainFinished: false,
    runTargets: [],
    instance,
    settings: [],
    lead: {
      id: parseRepoId.parse("lead"),
      sessionId: null,
      status: live ? "stopped" : "idle",
    },
  };
  let send: ((command: Command) => Promise<AckOutcome>) | null = null;
  const listeners = new Set<() => void>();

  const revealStage = (id: TaskId) => {
    const stage = state.snapshot.tasks.find((task) => task.id === id)?.stage;
    if (stage && state.ui.listSections[stage]?.collapsed) {
      state = {
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
  };

  const emit = () => {
    if (pendingSelection) {
      revealStage(pendingSelection);
      const cursor = cursorRows(state).findIndex(
        (row) => row.task.id === pendingSelection,
      );
      if (cursor >= 0) {
        state = {
          ...state,
          ui: {
            ...state.ui,
            cursor,
            selectionVersion: state.ui.selectionVersion + 1,
          },
        };
        pendingSelection = null;
      }
    }
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
          ? await sendWithMergeNotification(parsed.data, send)
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
    /** The human looked at Main: its finished dot clears. */
    markMainRead() {
      if (!state.mainFinished) return;
      state = { ...state, mainFinished: false };
      emit();
    },
    /** The human opened or focused these panes: their finished dots clear. */
    markPanesRead(
      panes: readonly Pick<PaneView, "hostGeneration" | "paneId">[],
    ) {
      const keys = panes
        .map((pane) => JSON.stringify([pane.hostGeneration, pane.paneId]))
        .filter((key) => !state.readFinished.has(key));
      if (!keys.length) return;
      state = {
        ...state,
        readFinished: new Set([...state.readFinished, ...keys]),
      };
      emit();
    },
    setChimeMuted(chimeMuted: boolean) {
      setUi({ chimeMuted });
    },
    setConnection(connection: string) {
      if (connection !== "connected") paneTransitions.reset();
      state = { ...state, connection };
      emit();
    },
    applyProtocol(client: ClientState, patch?: PatchFrame) {
      const selectedPr = selectedPullRequests(state)[state.ui.prCursor];
      const selectedTask =
        state.ui.view === "needs-you"
          ? undefined
          : cursorRows(state)[state.ui.cursor]?.task.id;
      const selectedStage = state.snapshot.tasks.find(
        (task) => task.id === selectedTask,
      )?.stage;
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
        pullRequestLists:
          !patch || patch.changes.some((c) => c.collection === "pull_requests")
            ? [...client.collections.pull_requests.values()]
            : state.pullRequestLists,
        pullRequestDetails:
          !patch ||
          patch.changes.some((c) => c.collection === "pull_request_detail")
            ? [...client.collections.pull_request_detail.values()]
            : state.pullRequestDetails,
        inbox:
          !patch || patch.changes.some((c) => c.collection === "inbox")
            ? [...client.collections.inbox.values()]
            : state.inbox,
        ui: (() => {
          const repo = client.collections.project.get("project")?.repoId ?? "";
          return repo === state.ui.repo
            ? state.ui
            : {
                ...state.ui,
                repo,
                cursor: 0,
                prCursor: 0,
                openTask: null,
                openPr: null,
                openRun: null,
                openReason: null,
              };
        })(),
        lead: client.collections.lead.get(
          client.collections.project.get("project")?.repoId ?? "",
        ) ?? {
          id: parseRepoId.parse("lead"),
          sessionId: null,
          status: "stopped",
        },
        operator: client.collections.operator.get("operator") ?? null,
        notes:
          !patch || patch.changes.some((c) => c.collection === "note")
            ? [...client.collections.note.values()]
            : state.notes,
        settings:
          !patch || patch.changes.some((c) => c.collection === "settings")
            ? [...client.collections.settings.values()]
            : state.settings,
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
      if (selectedPr) {
        const rows = selectedPullRequests(state);
        const index = rows.findIndex(
          (pr) =>
            pr.repoId === selectedPr.repoId && pr.number === selectedPr.number,
        );
        state = {
          ...state,
          ui: {
            ...state.ui,
            prCursor:
              index >= 0
                ? index
                : Math.max(0, Math.min(state.ui.prCursor, rows.length - 1)),
          },
        };
      }
      // Preserve the selected issue when a stage patch changes its sorted position.
      if (selectedTask) {
        const stageChanged =
          state.snapshot.tasks.find((task) => task.id === selectedTask)
            ?.stage !== selectedStage;
        if (stageChanged) revealStage(selectedTask);
        const cursor = cursorRows(state).findIndex(
          (row) => row.task.id === selectedTask,
        );
        if (cursor >= 0)
          state = {
            ...state,
            ui: {
              ...state.ui,
              cursor,
              selectionVersion:
                state.ui.selectionVersion + (stageChanged ? 1 : 0),
            },
          };
      }
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
      if (transitions.length) {
        // A fresh finish is unread until the human looks at that pane again.
        const byRun = new Map(state.snapshot.runs.map((run) => [run.id, run]));
        const read = new Set(state.readFinished);
        for (const pane of transitions)
          if (
            paneIndicator(pane, pane.runId ? byRun.get(pane.runId) : undefined)
              .tone === "finished"
          )
            read.delete(JSON.stringify([pane.hostGeneration, pane.paneId]));
        if (read.size !== state.readFinished.size)
          state = { ...state, readFinished: read };
      }
      // Main is not a task run: its turn boundaries come from the lead state. Working → idle
      // is a finish (unread until looked at), working → waiting needs the human; both chime.
      let leadTransition: PaneView | undefined;
      if (
        previous.lead.status === "working" &&
        (state.lead.status === "idle" || state.lead.status === "waiting")
      ) {
        if (state.lead.status === "idle")
          state = { ...state, mainFinished: true };
        leadTransition = state.panes.find(
          (pane) =>
            pane.sessionName === `loom-lead-${state.ui.repo}` && !pane.dead,
        );
      }
      emit();
      for (const pane of transitions)
        for (const listener of transitionListeners) listener(pane);
      if (leadTransition)
        for (const listener of transitionListeners) listener(leadTransition);
    },
    openAttention(
      task: TaskId,
      reason: AttentionReason,
      tab: TabId,
      run: RunId | null,
    ) {
      setUi({
        openTask: task,
        openPr: null,
        openReason: reason,
        openRun: run,
        tab,
      });
    },
    setRun(openRun: RunId | null) {
      setUi({ openRun });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setTrackerVisible(trackerVisible: boolean) {
      setUi({ trackerVisible });
    },
    setPrTab(prTab: UiState["prTab"]) {
      setUi({ prTab, prCursor: 0 });
    },
    togglePrSection(section: import("./pull-requests.js").ReviewSection) {
      const collapsed = state.ui.prSections[section] ?? section === "completed";
      setUi({
        prSections: { ...state.ui.prSections, [section]: !collapsed },
        prCursor: 0,
      });
    },
    loadMoreCompletedPrs() {
      setUi({ prCompletedCount: state.ui.prCompletedCount + 20 });
    },
    setPrQuery(prQuery: string) {
      setUi({ prQuery, prCursor: 0 });
    },
    openPullRequest(openPr: UiState["openPr"]) {
      setUi({ openPr, openTask: null, openRun: null, openReason: null });
    },
    setPrCursor(prCursor: number) {
      setUi({ prCursor });
    },
    setView(view: ViewId) {
      setUi({ view, cursor: 0, openTask: null, openPr: null });
    },
    setPane(pane: Pane) {
      setUi({ pane, cursor: 0 });
    },
    toggleListSection(stage: Stage) {
      const section = state.ui.listSections[stage];
      setUi({
        listSections: {
          ...state.ui.listSections,
          [stage]: { ...section, collapsed: !section?.collapsed },
        },
        cursor: 0,
      });
    },
    loadMoreListSection(stage: "done" | "canceled") {
      const section = state.ui.listSections[stage];
      setUi({
        listSections: {
          ...state.ui.listSections,
          [stage]: {
            ...section,
            visibleCount:
              (section?.visibleCount ?? LIST_PAGE_SIZE) + LIST_PAGE_SIZE,
          },
        },
      });
    },
    async setRepo(repo: string) {
      if (!state.snapshot.repos.some((item) => item.id === repo))
        throw new Error("Unknown registered repository");
      if (live) {
        if (!send) throw new Error("Coordinator is disconnected");
        const outcome = await send({
          kind: "select_repo",
          repoId: parseRepoId.parse(repo),
        });
        if (!outcome.ok) throw new Error(outcome.error.message);
      } else
        setUi({
          repo,
          cursor: 0,
          prCursor: 0,
          openTask: null,
          openPr: null,
          openRun: null,
          openReason: null,
        });
    },
    async addRepo() {
      const folder = await window.loomHost.chooseRepository();
      if (!folder) return;
      if (!send) throw new Error("Coordinator is disconnected");
      const outcome = await send({ kind: "add_repo", ...folder });
      if (!outcome.ok) throw new Error(outcome.error.message);
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
        openPr: null,
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
    setCreateIssue(createIssue: boolean) {
      setUi({ createIssue, palette: false, stagePicker: false });
    },
    selectCreatedTask(id: TaskId, repo: string, todo: boolean) {
      pendingSelection = id;
      setUi({
        createIssue: false,
        openPr: null,
        view: "all",
        pane: "list",
        ...(live ? {} : { repo }),
        query: "",
        searching: false,
        openTask: null,
        openRun: null,
        openReason: null,
        cursor: 0,
        toast: `Created ${id}${todo ? " · workflow start queued" : ""}`,
      });
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

    createTask(
      title: string,
      repo: string,
      options: {
        description?: string;
        size?: Task["size"];
        requirePlanApproval?: boolean;
      } = {},
    ) {
      if (live) {
        api.toast("This action is not available in the live Tracker yet.");
        return;
      }
      const repoId = repo;
      const at = minutesBefore(0);
      const id = `LOOM-${state.snapshot.tasks.length + 101}` as TaskId;
      const task: Task = {
        id,
        repoId: repoId as Task["repoId"],
        title,
        description: options.description ?? "",
        summary: null,
        stage: "backlog",
        stageEnteredAt: at,
        version: 1,
        blocked: null,
        failed: null,
        requirePlanApproval: options.requirePlanApproval ?? true,
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
        size: options.size ?? "normal",
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
      return id;
    },
  };

  return api;
}
