import { displayName, type Task } from "@loom/core";
import { useState } from "react";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { taskFindings } from "../store/selectors.js";
import { clock, since } from "./format.js";
import { IssueAgentsRail } from "./issue-agents-rail.js";
import { PrMarkdown } from "./pull-request-overview.js";
import { useTaskEvents } from "./use-task-events.js";

export function IssueOverview({ task }: { task: Task }) {
  const plan = useStore((state) => state.snapshot.plans[task.id]);
  const findings = useStore(
    (state) => taskFindings(state.snapshot, task),
    shallowArray,
  );
  const now = useStore((state) => state.snapshot.now);
  const ci = useStore(
    (state) => state.inbox.find((row) => row.taskId === task.id)?.ci ?? null,
  );
  const events = useTaskEvents(task);
  const [allActivity, setAllActivity] = useState(false);
  const store = useStoreApi();
  const settled = (status: string) =>
    ["resolved", "fixed", "waived"].includes(status);
  const sortedFindings = [...findings].sort(
    (a, b) =>
      Number(settled(a.status)) - Number(settled(b.status)) ||
      Number(b.blocking) - Number(a.blocking),
  );
  const shownEvents = allActivity ? events : events.slice(0, 5);
  return (
    <div className="pr-overview issue-overview">
      <main className="pr-story">
        <h1>{displayName(task)}</h1>
        <div className="task-description">
          {task.description.trim() ? (
            <PrMarkdown body={task.description} />
          ) : (
            <p className="faint">No description.</p>
          )}
        </div>
        <div className="section-title">Plan</div>
        {plan ? (
          <div className="panel">
            <strong>{plan.goal}</strong>
            <div className="faint">
              {plan.steps.length} steps · version {plan.version}
            </div>
            <button type="button" onClick={() => store.setTab("plan")}>
              Open plan
            </button>
          </div>
        ) : (
          <div className="faint">No plan yet.</div>
        )}
        {task.stage === "ci" ? (
          <>
            <div className="section-title">CI</div>
            <div className="panel" data-testid="ci-status">
              <div className="detail-meta">
                <strong>Commit {ci?.headSha.slice(0, 7) ?? "unknown"}</strong>
                <span className="chip">{ci?.conclusion ?? "waiting"}</span>
                <span className="spacer" />
                <span className="faint">
                  {ci
                    ? `${since(now, ci.since)} since submission`
                    : "Submitted"}
                </span>
              </div>
              {ci?.checks.length ? (
                ci.checks.map((check) => (
                  <div
                    className="detail-meta"
                    key={`${check.name}:${check.url ?? ""}`}
                  >
                    <span
                      className={`chip ${check.conclusion === "failure" ? "danger" : ""}`}
                    >
                      {check.status === "in_progress"
                        ? "running"
                        : (check.conclusion ?? check.status)}
                    </span>
                    {check.url ? (
                      <a href={check.url} target="_blank" rel="noreferrer">
                        {check.name}
                      </a>
                    ) : (
                      <span>{check.name}</span>
                    )}
                  </div>
                ))
              ) : (
                <div className="faint">No checks reported yet</div>
              )}
            </div>
          </>
        ) : null}
        <div className="section-title">
          Findings
          {findings.length
            ? ` · ${findings.filter((f) => f.blocking && !settled(f.status)).length} open and blocking`
            : ""}
        </div>
        {sortedFindings.length ? (
          sortedFindings.map((f) => (
            <div
              className={`panel issue-finding ${settled(f.status) ? "settled" : ""}`}
              key={f.id}
            >
              <div className="detail-meta">
                <strong>{f.title}</strong>
                <span
                  className={`chip ${f.severity === "blocker" || f.severity === "major" ? "danger" : ""}`}
                >
                  {f.severity}
                </span>
                <span className="chip">{f.status}</span>
                {f.blocking && !settled(f.status) ? (
                  <span className="chip danger">blocking</span>
                ) : null}
                <span className="spacer" />
                <span className="faint">
                  {f.source} · round {f.round}
                </span>
              </div>
              {f.location?.path ? (
                <div className="mono faint">
                  {f.location.path}:{f.location.startLine ?? "?"}
                </div>
              ) : null}
              <PrMarkdown body={f.body} />
            </div>
          ))
        ) : (
          <div className="faint">No findings.</div>
        )}
        <div className="section-title">Activity</div>
        {shownEvents.map((event) => (
          <div className="event" key={event.id}>
            <span className="faint mono">{clock(event.at)}</span>
            <span
              className={`dot ${event.kind === "flag" ? "blocked" : event.kind === "run" ? "working" : ""}`}
            />
            <span>
              <div>{event.text}</div>
              {event.detail ? (
                <div className="faint">{event.detail}</div>
              ) : null}
            </span>
          </div>
        ))}
        {events.length > 5 ? (
          <button type="button" onClick={() => setAllActivity((v) => !v)}>
            {allActivity
              ? "Show recent activity"
              : `Show all activity (${events.length})`}
          </button>
        ) : null}
      </main>
      <IssueAgentsRail task={task} />
    </div>
  );
}
