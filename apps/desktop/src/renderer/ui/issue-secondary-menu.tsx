import { displayName, type Task } from "@loom/core";
import { useEffect, useRef, useState } from "react";
import { issueDecisions } from "../store/issue-actions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { useHumanCommand } from "./use-human-command.js";

export function IssueSecondaryMenu({ task }: { task: Task }) {
  const store = useStoreApi();
  const actions = useStore(
    (state) => issueDecisions(state, task).status.secondaryActions,
  );
  const { send, outcome, submitting } = useHumanCommand(task.id);
  const [canceling, setCanceling] = useState(false);
  const cancelAction = actions.find((action) => action.id === "cancel");
  return (
    <>
      <details className="pr-menu">
        <summary aria-label="Issue actions">•••</summary>
        <div className="pr-menu-items">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={!!action.disabledReason}
              title={action.disabledReason ?? undefined}
              onClick={() => {
                if (action.id === "cancel") setCanceling(true);
                else if (action.intent === "terminal") store.setTab("terminal");
                else if (action.intent === "pull-request" && task.prNumber)
                  store.openPullRequest({
                    repoId: task.repoId,
                    number: task.prNumber,
                  });
                else if (action.command) void send(action.command());
              }}
            >
              {action.label}
            </button>
          ))}
          {outcome.message ? (
            <div className="pr-outcome" role="status">
              {outcome.message}
            </div>
          ) : null}
        </div>
      </details>
      {canceling && cancelAction?.command ? (
        <ConfirmIssueCancel
          task={task}
          disabled={submitting || !!cancelAction.disabledReason}
          onCancel={() => setCanceling(false)}
          onConfirm={(reason) => {
            setCanceling(false);
            const command = cancelAction.command?.(reason);
            if (command) void send(command);
          }}
        />
      ) : null}
    </>
  );
}

function ConfirmIssueCancel({
  task,
  disabled,
  onCancel,
  onConfirm,
}: {
  task: Task;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="create-issue-dialog pr-confirm"
      aria-labelledby="issue-cancel-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="issue-cancel-title">Cancel issue</h2>
      <p>{displayName(task)}</p>
      <label>
        Reason
        <textarea
          aria-label="Cancellation reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="pr-actions">
        <button type="button" onClick={onCancel}>
          Back
        </button>
        <button
          type="button"
          disabled={disabled || !reason.trim()}
          onClick={() => onConfirm(reason.trim())}
        >
          Confirm cancellation
        </button>
      </div>
    </dialog>
  );
}
