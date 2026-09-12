import type { HumanCommand, Task } from "@loom/core";
import { findingId } from "@loom/protocol";
import { useState } from "react";
import { REASON_LABELS, reasonTab } from "../store/inbox.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";

/** Every click sends one command; no optimistic edits to coordinator-owned facts. */
export function InboxActions({ task }: { task: Task }) {
  const store = useStoreApi();
  const reason = useStore((s) => s.ui.openReason);
  const info = useStore((s) => s.inbox.find((i) => i.taskId === task.id));
  const connection = useStore((s) => s.connection);
  const openRun = useStore((s) => s.ui.openRun);
  const questions = useStore(
    (s) =>
      s.snapshot.questions.filter(
        (q) => q.taskId === task.id && q.answer === null,
      ),
    shallowArray,
  );
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [questionId, setQuestionId] = useState("");
  if (!reason) return null;
  const runs = info?.reasonRuns[reason] ?? [];
  const question =
    questions.find((q) => q.id === questionId) ??
    questions.find((q) => q.runId === openRun) ??
    questions[0];
  const send = async (command: HumanCommand) => {
    setPending(true);
    try {
      const result = await store.command({
        kind: "human",
        taskId: task.id,
        command,
      });
      setOutcome(
        result.ok
          ? result.result.kind === "human"
            ? `Queued by coordinator (${result.result.inputId}). Activity shows the reconciled result.`
            : "Acknowledged by coordinator."
          : `${result.error.code}: ${result.error.message} ${result.error.details.join("; ")}`,
      );
    } finally {
      setPending(false);
    }
  };
  const disabled = pending || connection !== "connected";
  const active = task.attention.reasons.includes(reason);
  return (
    <div className="inbox-actions panel">
      <strong>
        {REASON_LABELS[reason]}
        {active ? "" : " · cleared"}
      </strong>
      {runs.length > 1 ? (
        <select
          aria-label="Run needing attention"
          value={openRun ?? ""}
          onChange={(e) => {
            const run = runs.find((r) => r.id === e.target.value);
            if (run)
              store.openAttention(
                task.id,
                reason,
                reasonTab(reason, run),
                run.id,
              );
          }}
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.role} · {run.provider} · {run.mode} · {run.id}
            </option>
          ))}
        </select>
      ) : null}
      {reason === "needs_approval" ? (
        <div className="mono">
          Reviewed SHA: {info?.reviewedHead ?? "not available"}
        </div>
      ) : null}
      {reason === "plan_needs_approval" ? (
        <div>Plan version: {info?.planVersion ?? "not available"}</div>
      ) : null}
      {reason === "question" && questions.length ? (
        <>
          <select
            aria-label="Question"
            value={question?.id ?? ""}
            onChange={(e) => setQuestionId(e.target.value)}
          >
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.question}
              </option>
            ))}
          </select>
          <div>{question?.question}</div>
        </>
      ) : null}
      {["plan_needs_approval", "needs_approval", "question"].includes(
        reason,
      ) ? (
        <textarea
          aria-label="Answer or feedback"
          placeholder={
            reason === "question" ? "Your answer" : "Feedback for the agent"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : null}
      <div className="detail-meta">
        {reason === "plan_needs_approval" ? (
          <>
            <button
              type="button"
              disabled={disabled || !active || info?.planVersion == null}
              onClick={() =>
                info?.planVersion != null &&
                void send({
                  type: "approve_plan",
                  planVersion: info.planVersion,
                })
              }
            >
              Approve plan
            </button>
            <button
              type="button"
              disabled={disabled || !active || !text.trim()}
              onClick={() =>
                void send({ type: "reject_plan", feedback: text.trim() })
              }
            >
              Reject plan
            </button>
          </>
        ) : null}
        {reason === "needs_approval" ? (
          <>
            <button
              type="button"
              disabled={disabled || !active || !info?.reviewedHead}
              onClick={() =>
                info?.reviewedHead &&
                void send({ type: "approve", headSha: info.reviewedHead })
              }
            >
              Approve merge
            </button>
            <button
              type="button"
              disabled={disabled || !active || !text.trim()}
              onClick={() =>
                void send({
                  type: "request_changes",
                  findings: [
                    {
                      id: findingId.parse(
                        `${task.id}/human/${crypto.randomUUID()}`,
                      ),
                      severity: "major",
                      title: "Requested changes",
                      body: text.trim(),
                      anchor: null,
                    },
                  ],
                })
              }
            >
              Request changes
            </button>
          </>
        ) : null}
        {reason === "question" ? (
          <button
            type="button"
            disabled={disabled || !question || !text.trim()}
            onClick={() =>
              question &&
              void send({
                type: "answer_question",
                questionId: question.id,
                answer: text.trim(),
              })
            }
          >
            Answer question
          </button>
        ) : null}
        {[
          "failed",
          "blocked",
          "run_vanished",
          "stalled",
          "status_unknown",
          "over_budget",
        ].includes(reason) ? (
          <button
            type="button"
            disabled={disabled || !active}
            onClick={() => void send({ type: "retry" })}
          >
            Retry
          </button>
        ) : null}
      </div>
      {outcome ? <div role="status">{outcome}</div> : null}
    </div>
  );
}
