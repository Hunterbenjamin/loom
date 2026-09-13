import { Command } from "cmdk";
import {
  deleteDisabledReason,
  mergeDisabledReason,
} from "../store/pull-requests.js";
import { useStore } from "../store/react.js";
import type { UiState } from "../store/store.js";

const ACTIONS = [
  { action: "merge", label: "Squash and merge", key: "m" },
  { action: "delete", label: "Delete branch", key: "d" },
  { action: "open", label: "Open on GitHub", key: "o" },
  { action: "refresh", label: "Refresh pull request", key: "r" },
] as const;
export type PullRequestActionRequest = NonNullable<UiState["openPr"]> & {
  action: (typeof ACTIONS)[number]["action"];
};
export const PULL_REQUEST_ACTION_EVENT = "loom:pull-request-action";

export function pullRequestShortcut(key: string) {
  return ACTIONS.find((item) => item.key === key)?.action;
}

export function requestPullRequestAction(request: PullRequestActionRequest) {
  window.dispatchEvent(
    new CustomEvent(PULL_REQUEST_ACTION_EVENT, { detail: request }),
  );
}

export function PullRequestPaletteCommands({ close }: { close(): void }) {
  const selection = useStore((s) => s.ui.openPr);
  const pr = useStore(
    (s) =>
      s.pullRequestDetails.find(
        (row) =>
          row.repoId === selection?.repoId && row.number === selection?.number,
      )?.detail,
  );
  const summary = useStore((s) =>
    s.snapshot.pullRequests.find(
      (row) =>
        row.repoId === selection?.repoId && row.number === selection?.number,
    ),
  );
  const disconnected = useStore((s) => s.live && s.connection !== "connected");
  if (!selection) return null;
  return (
    <Command.Group heading={`Pull request #${selection.number}`}>
      {ACTIONS.map(({ action, label, key }) => {
        const reason =
          action === "open"
            ? pr || summary
              ? null
              : "Waiting for pull request detail."
            : disconnected
              ? "Disconnected from the coordinator."
              : action === "refresh"
                ? null
                : !pr
                  ? "Waiting for pull request detail."
                  : action === "merge"
                    ? mergeDisabledReason(pr)
                    : deleteDisabledReason(pr);
        return (
          <Command.Item
            key={action}
            value={`pull-request-${action} ${label}`}
            disabled={!!reason}
            title={reason ?? undefined}
            onSelect={() => {
              close();
              requestPullRequestAction({ ...selection, action });
            }}
          >
            {label} <kbd>{key}</kbd>
          </Command.Item>
        );
      })}
    </Command.Group>
  );
}
