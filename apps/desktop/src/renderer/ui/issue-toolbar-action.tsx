import type { HumanCommand, Task } from "@loom/core";
import { issueDecisions } from "../store/issue-actions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { useTrackerActions } from "./tracker-actions.js";
import { keyHint } from "./tracker-keymap.js";
import type { HumanCommandOutcome } from "./use-human-command.js";

export function IssueToolbarAction({
  task,
  onCommand,
  onKeyboardApprove,
  onChangePlan,
  onRequestChanges,
  outcome,
  submitting,
  pending,
  approvalUnavailableReason,
}: {
  task: Task;
  onCommand: (command: HumanCommand) => void;
  onKeyboardApprove: (command: HumanCommand) => void;
  onChangePlan: () => void;
  onRequestChanges: () => void;
  outcome: HumanCommandOutcome;
  submitting: boolean;
  /** The command in flight: its button shows progress instead of status text. */
  pending: HumanCommand["type"] | null;
  approvalUnavailableReason?: string | null;
}) {
  const decision = useStore((state) => {
    const decisions = issueDecisions(state, task).decisions;
    return (
      decisions.find((item) => item.kind === "plan_needs_approval") ??
      decisions.find((item) => item.kind === "needs_approval") ??
      decisions.find((item) => item.actions.length > 0)
    );
  });
  const store = useStoreApi();
  const activate = (id: string, keyboard = false) => {
    const action = decision?.actions.find((action) => action.id === id);
    if (
      !action ||
      submitting ||
      pending !== null ||
      action.disabledReason ||
      (decision?.kind === "needs_approval" && approvalUnavailableReason)
    )
      return;
    if (id === "change-plan") onChangePlan();
    else if (id === "request-changes") onRequestChanges();
    else if (action.command)
      (keyboard ? onKeyboardApprove : onCommand)(action.command());
    else if (action.intent === "terminal") store.setTab("terminal");
  };
  useTrackerActions({
    approve: () =>
      activate(
        decision?.kind === "plan_needs_approval"
          ? "approve-plan"
          : "approve-merge",
        true,
      ),
    merge: () => activate("approve-merge", true),
    change: () =>
      activate(
        decision?.kind === "plan_needs_approval"
          ? "change-plan"
          : "request-changes",
      ),
  });
  if (!decision) return null;
  // Approvals show every action with the primary one last and rightmost; the secondary action
  // (Change plan, Request changes) opens a dialog for the human's feedback.
  const primary = new Set(["approve-plan", "approve-merge"]);
  const secondary = new Set(["change-plan", "request-changes"]);
  const actions =
    decision.kind === "plan_needs_approval" ||
    decision.kind === "needs_approval"
      ? [...decision.actions].sort(
          (a, b) => Number(primary.has(a.id)) - Number(primary.has(b.id)),
        )
      : decision.actions.slice(0, 1);
  const commandType = (action: (typeof actions)[number]) =>
    action.id === "change-plan"
      ? "reject_plan"
      : action.id === "request-changes"
        ? "request_changes"
        : action.command?.("").type;
  const busy = pending !== null;
  const disabledReasons = [
    ...new Set([
      ...(decision.kind === "needs_approval" && approvalUnavailableReason
        ? [approvalUnavailableReason]
        : []),
      ...actions.flatMap((action) =>
        action.disabledReason ? [action.disabledReason] : [],
      ),
    ]),
  ];
  return (
    <div className="issue-toolbar-action">
      {actions.map((action) => {
        const loading = busy && commandType(action) === pending;
        return (
          <button
            key={action.id}
            data-issue-action={action.id}
            type="button"
            className={secondary.has(action.id) ? "secondary" : undefined}
            disabled={
              submitting ||
              busy ||
              !!action.disabledReason ||
              (decision.kind === "needs_approval" &&
                !!approvalUnavailableReason)
            }
            data-pr-action={action.id === "approve-merge" ? "merge" : undefined}
            aria-busy={loading || undefined}
            {...(primary.has(action.id)
              ? keyHint("approve", action.disabledReason ?? action.label)
              : secondary.has(action.id)
                ? keyHint("change", action.disabledReason ?? action.label)
                : { title: action.disabledReason ?? undefined })}
            onClick={() => activate(action.id)}
          >
            {loading ? (
              <span className="button-spinner" aria-hidden="true" />
            ) : null}
            {action.label}
          </button>
        );
      })}
      {disabledReasons.map((reason) => (
        <span className="disabled-reason" key={reason}>
          {reason}
        </span>
      ))}
      {/* Progress shows on the button; only a refusal needs words. */}
      {outcome.kind === "refused" ? (
        <span className="pr-outcome danger" role="alert">
          {outcome.message}
        </span>
      ) : null}
    </div>
  );
}
