import { Command } from "cmdk";
import { selectedDetailTask } from "../store/detail-selection.js";
import {
  deleteDisabledReason,
  mergeDisabledReason,
} from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import { runTrackerAction } from "./tracker-actions.js";
import { formatKeys, trackerKeymap } from "./tracker-keymap.js";

const ACTIONS = trackerKeymap.filter((entry) => entry.group === "Pull request");

export function PullRequestPaletteCommands({ close }: { close(): void }) {
  const store = useStoreApi();
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
  const task = useStore(selectedDetailTask);
  const disconnected = useStore((s) => s.connection !== "connected");
  if (!selection) return null;
  return (
    <Command.Group heading={`Pull request #${selection.number}`}>
      {ACTIONS.filter(
        ({ id: action }) =>
          !task ||
          action === "merge" ||
          action === "github" ||
          action === "refresh",
      ).map(({ id: action, label }) => {
        const reason =
          task && action === "merge"
            ? "Use Approve merge on the issue’s reviewed head."
            : action === "github"
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
              runTrackerAction(store, action);
            }}
          >
            {task && action === "merge" ? "Approve merge on issue" : label}{" "}
            <kbd>{formatKeys(action)}</kbd>
          </Command.Item>
        );
      })}
    </Command.Group>
  );
}
