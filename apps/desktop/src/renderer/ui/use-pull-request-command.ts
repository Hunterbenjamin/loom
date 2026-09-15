import type { PullRequestCommand } from "@loom/protocol";
import { useRef, useState } from "react";
import { useStoreApi } from "../store/react.js";

/** What the human sees while the coordinator carries a command out and confirms it on GitHub. */
function busyLabel(kind: PullRequestCommand["kind"]): string {
  switch (kind) {
    case "merge_pull_request":
      return "Merging on GitHub…";
    case "close_pull_request":
      return "Closing on GitHub…";
    case "delete_branch":
      return "Deleting branch on GitHub…";
    case "refresh_pull_requests":
      return "Refreshing from GitHub…";
    default:
      return "Working…";
  }
}

export function usePullRequestCommand() {
  const store = useStoreApi();
  const [busy, setBusy] = useState<string | null>(null);
  const submitting = useRef(false);
  const [outcome, setOutcome] = useState("");
  async function run(command: PullRequestCommand) {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(busyLabel(command.kind));
    setOutcome("");
    try {
      const ack = await store.command(command);
      setOutcome(
        !ack.ok
          ? `${ack.error.code}: ${ack.error.message}${ack.error.details.length ? `\n${ack.error.details.join("\n")}` : ""}`
          : command.kind === "refresh_pull_requests"
            ? "Refreshed from GitHub."
            : command.kind === "pin_pull_request"
              ? command.pinned
                ? "Pull request pinned."
                : "Pull request unpinned."
              : command.kind === "link_pull_request"
                ? "Issue linked."
                : "Action completed; GitHub state is shown below.",
      );
      return ack.ok;
    } catch (error) {
      setOutcome(
        error instanceof Error
          ? error.message
          : "Command failed; refresh to check GitHub state.",
      );
      return false;
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }

  return { run, busy, submitting, outcome };
}
