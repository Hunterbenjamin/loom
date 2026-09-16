// One in-memory snapshot, one UI state, one subscription. Everything a panel renders comes
// from here; nothing reads disk or the network during an interaction.
import type { AttentionReason, RunId, Stage, TaskId } from "@loom/core";
import type {
  AckOutcome,
  ClientState,
  Command,
  Conversation,
  ConversationItem,
  Entities,
  LeadState,
  PaneView,
  PatchFrame,
  PullRequestDetailRow,
  RunTarget,
  SettingsDocument,
  TaskInbox,
} from "@loom/protocol";
import { repoId as parseRepoId } from "@loom/protocol";
import { emptySnapshot } from "../live/snapshot.js";
import { applyProtocol as applyProtocolState } from "./apply-protocol.js";
import { chatActions } from "./chat.js";
import { commandActions } from "./commands.js";
import { issueEditActions } from "./issue-actions.js";
import { paneActivity } from "./pane-transitions.js";
import { pullRequestActions } from "./pull-requests.js";
import { cursorItems, retainedCursor } from "./selectors.js";
import type { Snapshot } from "./snapshot.js";
import {
  applyPendingSelection,
  createInitialState,
  LIST_PAGE_SIZE,
  type Pane,
  type SortKey,
  sectionCollapsed,
  type TabId,
  type Theme,
  type UiState,
  type ViewId,
} from "./ui-state.js";

export interface State {
  snapshot: Snapshot;
  pullRequestLists: Entities["pull_requests"][];
  pullRequestDetails: PullRequestDetailRow[];
  ui: UiState;
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
  notes: Entities["note"][];
  instance: string;
  settings: SettingsDocument[];
  conversations: Conversation[];
  conversationItems: ConversationItem[];
}

export interface StoreContext {
  get(): State;
  set(state: State): void;
  setUi(patch: Partial<UiState>): void;
  emit(): void;
  sender(): ((command: Command) => Promise<AckOutcome>) | null;
  command(value: Command): Promise<AckOutcome>;
  toast(message: string | null): void;
}

export type Store = ReturnType<typeof createStore>;

export function createStore(
  snapshot: Snapshot = emptySnapshot(),
  instance = "unconfigured",
) {
  let pendingSelection: TaskId | null = null;
  let state = createInitialState(snapshot, instance);
  let send: ((command: Command) => Promise<AckOutcome>) | null = null;
  let runCommand: (value: Command) => Promise<AckOutcome>;
  const listeners = new Set<() => void>();
  const emit = () => {
    if (pendingSelection) {
      const applied = applyPendingSelection(
        state,
        pendingSelection,
        (next, id) =>
          cursorItems(next).findIndex(
            (item) => item.kind === "row" && item.row.task.id === id,
          ),
      );
      state = applied.state;
      if (applied.selected) pendingSelection = null;
    }
    for (const listener of listeners) listener();
  };
  const setUi = (patch: Partial<UiState>) => {
    state = { ...state, ui: { ...state.ui, ...patch } };
    emit();
  };
  const ctx: StoreContext = {
    get: () => state,
    set: (next) => {
      state = next;
    },
    setUi,
    emit,
    sender: () => send,
    command: (value) => runCommand(value),
    toast: (toast) => setUi({ toast }),
  };
  const commands = commandActions(ctx);
  runCommand = commands.command;
  const panes = paneActivity(ctx);
  const { applyPaneTransitions, resetPaneTransitions, ...paneActions } = panes;
  const edits = issueEditActions(ctx);

  return {
    getState: (): State => state,
    setSender(sender: (command: Command) => Promise<AckOutcome>) {
      send = sender;
    },
    ...commands,
    ...paneActions,
    toggleChimeMuted: () => setUi({ chimeMuted: !state.ui.chimeMuted }),
    setChimeMuted: (chimeMuted: boolean) => setUi({ chimeMuted }),
    setConnection(connection: string) {
      if (connection !== "connected") resetPaneTransitions();
      state = { ...state, connection };
      emit();
    },
    applyProtocol(client: ClientState, patch?: PatchFrame) {
      const previous = state;
      state = applyProtocolState(state, client, patch, edits.withPendingMoves);
      const notifyTransitions = applyPaneTransitions(previous);
      emit();
      notifyTransitions();
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
    setRun: (openRun: RunId | null) => setUi({ openRun }),
    ...chatActions(ctx),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTrackerVisible: (trackerVisible: boolean) => setUi({ trackerVisible }),
    ...pullRequestActions(ctx),
    setView(view: ViewId) {
      setUi({
        view,
        cursor: null,
        prCursor: null,
        openTask: null,
        openPr: null,
        openBrief: null,
        openResearch: null,
      });
    },
    openResearch: (openResearch: string | null) => setUi({ openResearch }),
    openBrief: (openBrief: string | null) => setUi({ openBrief }),
    setPane: (pane: Pane) => setUi({ pane, cursor: null }),
    toggleListSection(stage: Stage) {
      const selected = cursorItems(state)[state.ui.cursor ?? -1];
      const section = state.ui.listSections[stage];
      const ui = {
        ...state.ui,
        listSections: {
          ...state.ui.listSections,
          [stage]: {
            ...section,
            collapsed: !sectionCollapsed(state.ui.listSections, stage),
          },
        },
      };
      const next = { ...state, ui };
      setUi({ ...ui, cursor: retainedCursor(cursorItems(next), selected) });
    },
    loadMoreListSection(stage: "done" | "canceled") {
      const selected = cursorItems(state)[state.ui.cursor ?? -1];
      const section = state.ui.listSections[stage];
      const ui = {
        ...state.ui,
        listSections: {
          ...state.ui.listSections,
          [stage]: {
            ...section,
            visibleCount:
              (section?.visibleCount ?? LIST_PAGE_SIZE) + LIST_PAGE_SIZE,
          },
        },
      };
      const next = { ...state, ui };
      setUi({ ...ui, cursor: retainedCursor(cursorItems(next), selected) });
    },
    async setRepo(repo: string) {
      if (!state.snapshot.repos.some((item) => item.id === repo))
        throw new Error("Unknown registered repository");
      if (!send) throw new Error("Coordinator is disconnected");
      const outcome = await send({
        kind: "select_repo",
        repoId: parseRepoId.parse(repo),
      });
      if (!outcome.ok) throw new Error(outcome.error.message);
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
          : { sort, descending: sort === "time" },
      );
    },
    setCursor: (cursor: number | null) => setUi({ cursor }),
    moveCursor(delta: number, length: number) {
      if (length === 0) return;
      setUi({
        cursor:
          state.ui.cursor === null
            ? 0
            : Math.max(0, Math.min(length - 1, state.ui.cursor + delta)),
      });
    },
    open(task: TaskId | null) {
      setUi({
        openTask: task,
        openPr: null,
        openRun: null,
        openReason: null,
        tab: "overview",
      });
    },
    setTab: (tab: TabId) => setUi({ tab }),
    setTheme: (theme: Theme) => setUi({ theme }),
    toggleTheme: () =>
      setUi({ theme: state.ui.theme === "dark" ? "light" : "dark" }),
    setPalette: (palette: boolean) => setUi({ palette }),
    setCreateIssue: (createIssue: boolean) =>
      setUi({ createIssue, palette: false, stagePicker: false }),
    selectCreatedTask(id: TaskId, todo: boolean) {
      pendingSelection = id;
      setUi({
        createIssue: false,
        openPr: null,
        view: "all",
        pane: "list",
        openTask: null,
        openRun: null,
        openReason: null,
        cursor: 0,
        toast: `Created ${id}${todo ? " · workflow start queued" : ""}`,
      });
    },
    setStagePicker: (stagePicker: boolean) => setUi({ stagePicker }),
    toast: (toast: string | null) => setUi({ toast }),
    ...edits.actions,
  };
}
