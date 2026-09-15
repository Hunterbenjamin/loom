import { type Run, sumTokenUsage, type Task } from "@loom/core";
import { shallowArray, useStore } from "../store/react.js";
import { taskRuns } from "../store/selectors.js";
import {
  formatTokenUsage,
  RUN_STATUS_LABELS,
  since,
  stageLabel,
} from "./format.js";
import { useHumanCommand } from "./use-human-command.js";

export function IssueAgentsRail({
  task,
  embedded = false,
}: {
  task: Task;
  embedded?: boolean;
}) {
  const runs = useStore(
    (state) => taskRuns(state.snapshot, task),
    shallowArray,
  );
  const tests = useStore(
    (state) =>
      state.snapshot.testResults.filter((test) =>
        runs.some((run) => run.id === test.runId),
      ),
    shallowArray,
  );
  const now = useStore((state) => state.snapshot.now);
  const totalTokenUsage = sumTokenUsage(runs);
  const hasTokenUsage = runs.some((run) => run.tokenUsage?.length);
  const content = (
    <>
      <section>
        <h3>Stage</h3>
        <div className="pr-property">{stageLabel(task.stage)}</div>
      </section>
      <div className="section-title">Agents</div>
      {hasTokenUsage ? (
        <div className="faint" data-testid="issue-token-usage">
          Total tokens · {formatTokenUsage(totalTokenUsage)}
        </div>
      ) : null}
      {runs.length === 0 ? <div className="faint">No runs yet.</div> : null}
      {runs.map((run) => (
        <div className="panel" key={run.id}>
          <div className="detail-meta">
            <span className={`dot ${run.status}`} />
            <strong>{run.role}</strong>
            <span className="faint">· {run.provider}</span>
            <span className="spacer" />
            <span className="chip">{RUN_STATUS_LABELS[run.status]}</span>
          </div>
          <div className="faint mono">
            {run.model}
            {run.reasoningEffort ? ` · ${run.reasoningEffort}` : ""}
          </div>
          {run.tokenUsage?.length ? (
            <div className="faint" data-testid="run-token-usage">
              Tokens · {formatTokenUsage(sumTokenUsage([run]))}
            </div>
          ) : null}
          <div className="faint">
            {run.lastTurn?.error ??
              run.lastTurn?.outcome ??
              (run.status === "working" ? "working" : "idle")}
            {" · last activity "}
            {run.lastActivityAt
              ? `${since(now, run.lastActivityAt)} ago`
              : "never"}
          </div>
          {run.blockedOn ? (
            <span className="chip attention">{run.blockedOn}</span>
          ) : null}
          {run.pendingRequests.map((request) => (
            <div className="faint" key={request.id}>
              <span className="chip attention">{request.kind}</span>{" "}
              {request.summary}
            </div>
          ))}
          {run.pendingDialog ? (
            <div className="faint">
              <span className="chip attention">{run.pendingDialog.kind}</span>{" "}
              {run.pendingDialog.command ?? "Waiting for terminal input"}
            </div>
          ) : null}
          {run.origin === "loom" &&
          run.endReason !== "superseded" &&
          runs.filter((r) => r.origin === "loom" && r.role === run.role).at(-1)
            ?.id === run.id &&
          ((task.stage === "planning" && run.role === "planner") ||
            (task.stage === "in_progress" && run.role === "implementer") ||
            (task.stage === "in_review" && run.role === "reviewer")) ? (
            <RestartRun task={task} run={run} />
          ) : null}
        </div>
      ))}
      <div className="section-title">Tests</div>
      {tests.length ? (
        tests.map((test) => (
          <div key={`${test.command}:${test.ranAt}`} title={test.summary}>
            <span
              className={`chip ${test.outcome === "passed" ? "good" : "danger"}`}
            >
              {test.outcome}
            </span>{" "}
            <span className="mono">{test.command}</span>
          </div>
        ))
      ) : (
        <div className="faint">No test results yet.</div>
      )}
    </>
  );
  return embedded ? content : <aside className="pr-rail">{content}</aside>;
}

function RestartRun({ task, run }: { task: Task; run: Run }) {
  const connected = useStore((s) => s.live && s.connection === "connected");
  const { send, outcome, submitting } = useHumanCommand(task.id);
  return (
    <div className="panel">
      <button
        type="button"
        disabled={!connected || submitting}
        onClick={() => void send({ type: "restart_run", runId: run.id })}
      >
        Restart with current agent settings
      </button>
      <div className="faint">
        Starts a fresh session. Keeps this issue’s worktree, plan and findings.
      </div>
      {outcome.message ? (
        <div className="pr-outcome" role="status">
          {outcome.message}
        </div>
      ) : null}
    </div>
  );
}
