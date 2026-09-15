import type { ClientState, PatchFrame } from "@loom/protocol";
import { repoId as parseRepoId } from "@loom/protocol";
import { projectSnapshot } from "../live/snapshot.js";
import { selectedPullRequests } from "./pull-requests.js";
import { cursorRows } from "./selectors.js";
import type { State } from "./store.js";
import { resetUiForRepo, revealStage } from "./ui-state.js";

const changed = (patch: PatchFrame | undefined, collection: string) =>
  !patch || patch.changes.some((change) => change.collection === collection);

export function applyProtocol(
  state: State,
  client: ClientState,
  patch?: PatchFrame,
  reconcileSnapshot: (snapshot: State["snapshot"]) => State["snapshot"] =
    (snapshot) => snapshot,
): State {
  const selectedPr =
    state.ui.prCursor === null
      ? undefined
      : selectedPullRequests(state)[state.ui.prCursor];
  const selectedTask =
    state.ui.view === "needs-you" || state.ui.cursor === null
      ? undefined
      : cursorRows(state)[state.ui.cursor]?.task.id;
  const selectedStage = state.snapshot.tasks.find(
    (task) => task.id === selectedTask,
  )?.stage;
  const repo = client.collections.project.get("project")?.repoId ?? "";
  const repoChanged = repo !== state.ui.repo;
  let next: State = {
    ...state,
    snapshot: reconcileSnapshot(projectSnapshot(state.snapshot, client, patch)),
    pullRequestLists: changed(patch, "pull_requests")
      ? [...client.collections.pull_requests.values()]
      : state.pullRequestLists,
    pullRequestDetails: changed(patch, "pull_request_detail")
      ? [...client.collections.pull_request_detail.values()]
      : state.pullRequestDetails,
    inbox: changed(patch, "inbox")
      ? [...client.collections.inbox.values()]
      : state.inbox,
    ui: repoChanged ? resetUiForRepo(state.ui, repo) : state.ui,
    lead: client.collections.lead.get(repo) ?? {
      id: parseRepoId.parse("lead"),
      sessionId: null,
      status: "stopped",
    },
    notes: changed(patch, "note")
      ? [...client.collections.note.values()]
      : state.notes,
    settings: changed(patch, "settings")
      ? [...client.collections.settings.values()]
      : state.settings,
    panes: changed(patch, "pane")
      ? [...client.collections.pane.values()]
      : state.panes,
    panesUnavailable:
      client.collections.pane_inventory.get("panes")?.unavailable ?? false,
    runTargets: changed(patch, "run_target")
      ? [...client.collections.run_target.values()]
      : state.runTargets,
    conversations: changed(patch, "conversation")
      ? [...client.collections.conversation.values()]
      : state.conversations,
    conversationItems: changed(patch, "conversation_item")
      ? [...client.collections.conversation_item.values()]
      : state.conversationItems,
  };

  if (selectedPr && !repoChanged) {
    const rows = selectedPullRequests(next);
    const index = rows.findIndex(
      (pr) =>
        pr.repoId === selectedPr.repoId && pr.number === selectedPr.number,
    );
    next = {
      ...next,
      ui: {
        ...next.ui,
        prCursor:
          index >= 0
            ? index
            : rows.length === 0
              ? null
              : Math.max(0, Math.min(next.ui.prCursor ?? 0, rows.length - 1)),
      },
    };
  }

  if (selectedTask && !repoChanged) {
    const stageChanged =
      next.snapshot.tasks.find((task) => task.id === selectedTask)?.stage !==
      selectedStage;
    if (stageChanged) next = revealStage(next, selectedTask);
    const cursor = cursorRows(next).findIndex(
      (row) => row.task.id === selectedTask,
    );
    if (cursor >= 0)
      next = {
        ...next,
        ui: {
          ...next.ui,
          cursor,
          selectionVersion: next.ui.selectionVersion + (stageChanged ? 1 : 0),
        },
      };
  }
  return next;
}
