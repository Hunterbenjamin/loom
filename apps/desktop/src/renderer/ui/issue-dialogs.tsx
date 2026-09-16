import {
  displayName,
  type HumanCommand,
  type Sha,
  type Task,
} from "@loom/core";
import { useEffect, useRef } from "react";

export function ChangePlanDialog({
  task,
  capturedPlanVersion,
  currentPlanVersion,
  planGoal,
  action,
  draft,
  submitting,
  onDraftChange,
  onCancel,
  onSend,
}: {
  task: Task;
  capturedPlanVersion: number;
  currentPlanVersion: number | null;
  planGoal: string | null;
  action?: {
    disabledReason: string | null;
    command?: (text?: string) => HumanCommand;
  };
  draft: string;
  submitting: boolean;
  onDraftChange: (draft: string) => void;
  onCancel: () => void;
  onSend: (command: HumanCommand) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  const changedReason =
    currentPlanVersion !== capturedPlanVersion
      ? currentPlanVersion == null
        ? "The latest plan version is unavailable. Review it before sending changes."
        : `The plan changed to version ${currentPlanVersion}. Review it before sending changes.`
      : null;
  const disabledReason =
    changedReason ??
    action?.disabledReason ??
    (!draft.trim() ? "Describe the changes you want" : null);
  const goal = planGoal?.trim() || "Plan goal unavailable";
  const goalSummary =
    goal.length > 200 ? `${goal.slice(0, 199).trimEnd()}…` : goal;
  return (
    <dialog
      ref={dialog}
      className="create-dialog pr-confirm"
      aria-labelledby="issue-change-plan-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="issue-change-plan-title">Change plan</h2>
      <p>{displayName(task)}</p>
      <p>Plan version {capturedPlanVersion}</p>
      <p>{goalSummary}</p>
      <label>
        Requested changes
        <textarea
          aria-label="Requested changes"
          required
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
        />
      </label>
      {disabledReason ? (
        <p
          className="disabled-reason"
          role={changedReason ? "alert" : undefined}
        >
          {disabledReason}
        </p>
      ) : null}
      <div className="pr-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={submitting || !!disabledReason || !action?.command}
          onClick={() => {
            const command = action?.command?.(draft.trim());
            if (command) void onSend(command);
          }}
        >
          Send to planner
        </button>
      </div>
    </dialog>
  );
}

export function RequestChangesDialog({
  task,
  capturedHead,
  currentHead,
  action,
  draft,
  submitting,
  onDraftChange,
  onCancel,
  onSend,
}: {
  task: Task;
  capturedHead: string;
  currentHead: string | null;
  action?: {
    disabledReason: string | null;
    command?: (text?: string) => HumanCommand;
  };
  draft: string;
  submitting: boolean;
  onDraftChange: (draft: string) => void;
  onCancel: () => void;
  onSend: (command: HumanCommand) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  const changedReason =
    currentHead !== capturedHead
      ? "The reviewed head changed. Review it again before requesting changes."
      : null;
  const disabledReason =
    changedReason ??
    action?.disabledReason ??
    (!draft.trim() ? "Describe the changes you want" : null);
  return (
    <dialog
      ref={dialog}
      className="create-dialog pr-confirm"
      aria-labelledby="issue-request-changes-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="issue-request-changes-title">Request changes</h2>
      <p>{displayName(task)}</p>
      <p className="mono">Reviewed head {capturedHead.slice(0, 7)}</p>
      <label>
        Requested changes
        <textarea
          aria-label="Requested changes"
          required
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
        />
      </label>
      {disabledReason ? (
        <p
          className="disabled-reason"
          role={changedReason ? "alert" : undefined}
        >
          {disabledReason}
        </p>
      ) : null}
      <div className="pr-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={submitting || !!disabledReason || !action?.command}
          onClick={() => {
            const command = action?.command?.(draft.trim());
            if (command) void onSend(command);
          }}
        >
          Send to implementer
        </button>
      </div>
    </dialog>
  );
}

export function ConfirmIssueApproval({
  task,
  headSha,
  changed,
  disabled,
  onCancel,
  onConfirm,
}: {
  task: Task;
  headSha: Sha;
  changed: boolean;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
      className="create-dialog pr-confirm"
      aria-labelledby="issue-approve-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="issue-approve-title">Approve merge</h2>
      <p>{displayName(task)}</p>
      <p>
        Approve reviewed head <code>{headSha}</code> for merge.
      </p>
      {changed ? (
        <p role="alert">
          The reviewed head changed. Cancel and review the refreshed issue
          before confirming.
        </p>
      ) : null}
      <div className="pr-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={disabled} onClick={onConfirm}>
          Confirm approval
        </button>
      </div>
    </dialog>
  );
}

export function ConfirmPlanApproval({
  version,
  disabled,
  onCancel,
  onConfirm,
}: {
  version: number;
  disabled: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
      className="create-dialog pr-confirm"
      aria-labelledby="confirm-plan-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="confirm-plan-title">Approve plan</h2>
      <p>Approve plan version {version} and start implementation?</p>
      {disabled ? (
        <p role="alert">
          Approval is unavailable. Review the current plan before confirming.
        </p>
      ) : null}
      <div className="pr-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={disabled} onClick={onConfirm}>
          Confirm plan approval
        </button>
      </div>
    </dialog>
  );
}
