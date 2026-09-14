import type { HumanCommand, IsoTime, Task } from "@loom/core";
import { useState } from "react";
import {
  type DecisionAction,
  type IssueDecision,
  issueDecisions,
} from "../store/issue-actions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { since } from "./format.js";
import type { HumanCommandOutcome } from "./use-human-command.js";

export function IssueDecisionPanel({
  task,
  compact = false,
  onCommand,
  outcome,
  submitting,
}: {
  task: Task;
  compact?: boolean;
  onCommand: (command: HumanCommand) => void;
  outcome: HumanCommandOutcome;
  submitting: boolean;
}) {
  const store = useStoreApi();
  const data = useStore((state) => issueDecisions(state, task));
  const openReason = useStore((state) => state.ui.openReason);
  const openRun = useStore((state) => state.ui.openRun);
  const now = useStore((state) => state.snapshot.now);
  const [expanded, setExpanded] = useState(!compact);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<Record<string, string>>({});
  if (compact && !expanded)
    return (
      <div className="issue-decision-panel compact">
        <span>{data.decisions[0]?.label ?? data.status.summary}</span>
        <button type="button" onClick={() => setExpanded(true)}>
          Show actions
        </button>
      </div>
    );
  return (
    <section className="issue-decision-panel" aria-label="Issue actions">
      {compact ? (
        <button
          className="issue-collapse"
          type="button"
          onClick={() => setExpanded(false)}
        >
          Collapse actions
        </button>
      ) : null}
      {data.decisions.length ? (
        data.decisions.map((decision) => {
          const highlighted =
            decision.kind === openReason &&
            (!openRun || decision.runs.some((run) => run.id === openRun));
          const note = notes[decision.key] ?? "";
          const selectedQuestion =
            decision.questions?.find(
              (question) => question.id === questions[decision.key],
            ) ?? decision.questions?.[0];
          return (
            <article
              className="issue-decision"
              data-highlighted={highlighted}
              key={decision.key}
            >
              <div className="issue-decision-copy">
                <strong>{decision.label}</strong>
                <DecisionEvidence
                  decision={decision}
                  now={now}
                  question={selectedQuestion?.question}
                />
                {decision.kind === "plan_needs_approval" ? (
                  <button
                    type="button"
                    className="pr-task-link"
                    onClick={() => store.setTab("plan")}
                  >
                    Review plan
                  </button>
                ) : null}
              </div>
              {decision.questions && decision.questions.length > 1 ? (
                <select
                  aria-label="Question"
                  value={selectedQuestion?.id ?? ""}
                  onChange={(event) =>
                    setQuestions((value) => ({
                      ...value,
                      [decision.key]: event.target.value,
                    }))
                  }
                >
                  {decision.questions.map((question) => (
                    <option key={question.id} value={question.id}>
                      {question.question}
                    </option>
                  ))}
                </select>
              ) : null}
              {needsNote(decision) ? (
                <textarea
                  aria-label={
                    decision.kind === "question"
                      ? "Your answer"
                      : "Feedback for the agent"
                  }
                  placeholder={
                    decision.kind === "question"
                      ? "Your answer"
                      : "Feedback for the agent"
                  }
                  value={note}
                  onChange={(event) =>
                    setNotes((value) => ({
                      ...value,
                      [decision.key]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => event.stopPropagation()}
                />
              ) : null}
              <div className="issue-decision-actions">
                {decision.actions.map((action) => {
                  const noteAction = [
                    "reject-plan",
                    "request-changes",
                    "answer-question",
                  ].includes(action.id);
                  const reason =
                    noteAction &&
                    note.trim() &&
                    action.disabledReason === noteRequiredReason(action.id)
                      ? null
                      : action.disabledReason;
                  return (
                    <ActionButton
                      key={action.id}
                      action={action}
                      disabledReason={reason}
                      disabled={submitting}
                      onSend={() => {
                        const command = action.command?.(note.trim());
                        if (!command) return;
                        onCommand(
                          command.type === "answer_question" && selectedQuestion
                            ? { ...command, questionId: selectedQuestion.id }
                            : command,
                        );
                      }}
                      onIntent={() => {
                        if (action.intent === "terminal")
                          store.setTab("terminal");
                        if (action.intent === "plan") store.setTab("plan");
                        if (action.intent === "review") store.setTab("review");
                        if (action.intent === "pull-request" && task.prNumber)
                          store.openPullRequest({
                            repoId: task.repoId,
                            number: task.prNumber,
                          });
                      }}
                    />
                  );
                })}
              </div>
            </article>
          );
        })
      ) : (
        <div className="issue-status">
          <span className="dot working" />
          <span>{data.status.summary}</span>
          <span className="faint">
            last activity{" "}
            {data.status.lastActivityAt
              ? `${since(now, data.status.lastActivityAt)} ago`
              : "unknown"}
          </span>
        </div>
      )}
      {outcome.message ? (
        <div className={`pr-feedback pr-outcome ${outcome.kind}`} role="status">
          {outcome.message}
        </div>
      ) : null}
    </section>
  );
}

function noteRequiredReason(actionId: string) {
  if (actionId === "reject-plan") return "Enter feedback to reject the plan";
  if (actionId === "request-changes")
    return "Enter feedback to request changes";
  if (actionId === "answer-question") return "Enter an answer";
  return null;
}

function needsNote(decision: IssueDecision) {
  return (
    decision.kind === "plan_needs_approval" ||
    decision.kind === "needs_approval" ||
    decision.kind === "question"
  );
}

function DecisionEvidence({
  decision,
  now,
  question,
}: {
  decision: IssueDecision;
  now: IsoTime;
  question?: string;
}) {
  if (decision.kind === "plan_needs_approval")
    return <span>Plan version {decision.planVersion ?? "unavailable"}</span>;
  if (decision.kind === "needs_approval")
    return (
      <span className="mono" title={decision.reviewedHead ?? undefined}>
        Reviewed head{" "}
        {decision.reviewedHead
          ? decision.reviewedHead.slice(0, 8)
          : "unavailable"}
      </span>
    );
  if (decision.kind === "question")
    return <span>{question ?? "No open question"}</span>;
  if (decision.kind === "provider_request")
    return (
      <span>
        {decision.request?.summary} · {decision.request?.kind} ·{" "}
        {decision.since ? since(now, decision.since) : "—"} ago
      </span>
    );
  if (decision.kind === "pane_prompt")
    return (
      <span>
        <span className="mono">{decision.dialog?.tool}</span> ·{" "}
        {decision.dialog?.command ?? "Waiting for input"}
      </span>
    );
  return <span>{decision.reason ?? "The run needs attention"}</span>;
}

function ActionButton({
  action,
  disabledReason,
  disabled,
  onSend,
  onIntent,
}: {
  action: DecisionAction;
  disabledReason: string | null;
  disabled: boolean;
  onSend: () => void;
  onIntent: () => void;
}) {
  const blocked = disabled || !!disabledReason;
  return (
    <span className="issue-action-group">
      <button
        type="button"
        disabled={blocked}
        title={disabledReason ?? undefined}
        onClick={action.command ? onSend : onIntent}
      >
        {action.label}
      </button>
      {disabledReason ? (
        <span className="disabled-reason">{disabledReason}</span>
      ) : null}
    </span>
  );
}
