import type { Run, Task } from "@loom/core";
import { lazy, Suspense, useState } from "react";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { taskFindings, taskRuns } from "../store/selectors.js";
import type { TabId } from "../store/store.js";
import { AttentionChips } from "./bits.js";
import { clock, RUN_STATUS_LABELS, since, stageLabel } from "./format.js";
import { InboxActions } from "./inbox-actions.js";

// Both pull in a large dependency (Pierre, xterm) that the first screen never needs.
const DiffTab = lazy(() =>
  import("./diff.js").then((m) => ({ default: m.DiffTab })),
);
const TerminalTab = lazy(() =>
  import("./terminal.js").then((m) => ({ default: m.TerminalTab })),
);

const TABS: { id: TabId; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "plan", label: "Plan" },
  { id: "agents", label: "Agents" },
  { id: "terminal", label: "Terminal" },
  { id: "review", label: "Review" },
];

export function Detail({ task }: { task: Task }) {
  const store = useStoreApi();
  const reason = useStore((s) => s.ui.openReason);
  const live = useStore((s) => s.live);
  const tab = useStore((s) => s.ui.tab);
  const theme = useStore((s) => s.ui.theme);
  const now = useStore((s) => s.snapshot.now);
  const repo = useStore((s) =>
    s.snapshot.repos.find((item) => item.id === task.repoId),
  );

  return (
    <div className="detail" data-testid="detail" data-task={task.id}>
      <header className="detail-head">
        <div className="detail-meta">
          <span className="mono faint">{task.id}</span>
          <span className="chip">{stageLabel(task.stage)}</span>
          <AttentionChips task={task} />
          <span className="spacer" />
          <button type="button" onClick={() => store.open(null)}>
            Close <kbd>esc</kbd>
          </button>
        </div>
        <h2>{task.title}</h2>
        <div className="detail-meta faint">
          <span>{repo?.github}</span>
          {task.branch ? <span className="mono">{task.branch}</span> : null}
          {task.prNumber ? (
            <button
              type="button"
              onClick={() =>
                store.openPullRequest({
                  repoId: task.repoId,
                  number: task.prNumber as number,
                })
              }
            >
              PR #{task.prNumber}
            </button>
          ) : null}
          <span>in this stage {since(now, task.stageEnteredAt)}</span>
          <span>v{task.version}</span>
        </div>
        <InboxActions key={`${task.id}:${reason}`} task={task} />
      </header>
      <div className="tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-tab={item.id}
            onClick={() => store.setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="tab-body" data-tab-body={tab}>
        {tab === "activity" ? <Activity task={task} /> : null}
        {tab === "plan" ? <PlanTab task={task} /> : null}
        {tab === "agents" ? <Agents task={task} /> : null}
        <Suspense fallback={<div className="pad faint">Loading...</div>}>
          {tab === "terminal" ? (
            <TerminalTab task={task} theme={theme} />
          ) : null}
          {tab === "review" ? (
            live ? (
              <LiveReview task={task} />
            ) : (
              <DiffTab task={task} />
            )
          ) : null}
        </Suspense>
      </div>
    </div>
  );
}

function Activity({ task }: { task: Task }) {
  const notes = useStore(
    (s) => s.notes.filter((n) => n.taskId === task.id),
    shallowArray,
  );
  const transitions = useStore(
    (s) => s.snapshot.transitions.filter((t) => t.taskId === task.id),
    shallowArray,
  );
  const runs = useStore((s) => taskRuns(s.snapshot, task), shallowArray);
  const messages = useStore(
    (s) =>
      s.snapshot.messages.filter((m) =>
        s.snapshot.runs.some((r) => r.id === m.runId && r.taskId === task.id),
      ),
    shallowArray,
  );
  const now = useStore((s) => s.snapshot.now);

  const events = [
    ...notes.map((n) => ({
      id: n.id,
      at: n.at as import("@loom/core").IsoTime,
      kind: "note",
      text: n.body,
      detail: `${n.author} · ${n.row} · ${n.outcome}`,
    })),
    ...transitions.map((transition) => ({
      id: transition.id as string,
      at: transition.at,
      kind: transition.from === transition.to ? "flag" : "stage",
      text:
        transition.from === transition.to
          ? transition.reason
          : `${stageLabel(transition.from)} → ${stageLabel(transition.to)}`,
      detail:
        transition.trigger.kind === "human"
          ? `human · ${transition.trigger.command}`
          : transition.trigger.kind === "mcp"
            ? `mcp · ${transition.trigger.tool}`
            : `reconcile · ${transition.trigger.fact}`,
    })),
    ...messages.map((message) => ({
      id: message.id as string,
      at: message.sentAt ?? now,
      kind: "message",
      text: message.text,
      detail: `${message.purpose} · ${message.status}`,
    })),
    ...runs.flatMap((run) =>
      run.launchedAt
        ? [
            {
              id: `${run.id}:launched`,
              at: run.launchedAt,
              kind: "run",
              text: `${run.role} run launched on ${run.provider}`,
              detail: `${run.model} · attempt ${run.attempts}`,
            },
          ]
        : [],
    ),
    ...runs.flatMap((run) =>
      run.endedAt
        ? [
            {
              id: `${run.id}:ended`,
              at: run.endedAt,
              kind: "run",
              text: `${run.role} run ended`,
              detail: run.endReason ?? "",
            },
          ]
        : [],
    ),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <div className="pad timeline">
      <section className="task-description">
        <div className="section-title">Description</div>
        <div>{task.description.trim() || "No description."}</div>
      </section>
      {events.map((event) => (
        <div className="event" key={event.id}>
          <span className="faint mono">{clock(event.at)}</span>
          <span
            className={`dot ${event.kind === "flag" ? "blocked" : event.kind === "run" ? "working" : ""}`}
          />
          <span>
            <div>{event.text}</div>
            <div className="faint">{event.detail}</div>
          </span>
        </div>
      ))}
    </div>
  );
}

function PlanTab({ task }: { task: Task }) {
  const plan = useStore((s) => s.snapshot.plans[task.id]);
  const approval = useStore((s) =>
    s.snapshot.approvals.find(
      (item) => item.taskId === task.id && item.kind === "plan",
    ),
  );
  if (!plan) {
    return (
      <div className="pad faint">
        No plan yet. A planner run writes it before Todo leaves the queue.
      </div>
    );
  }
  return (
    <div className="pad">
      <div className="section-title">Goal</div>
      <div>{plan.goal}</div>
      {approval ? (
        <div className="panel" style={{ marginTop: 12 }}>
          <span className={`chip ${approval.voidedAt ? "danger" : "good"}`}>
            {approval.voidedAt ? `voided: ${approval.voidReason}` : "approved"}
          </span>{" "}
          plan v{approval.kind === "plan" ? approval.planVersion : 0}
        </div>
      ) : null}
      <div className="section-title">Non-goals</div>
      <ul className="plain">
        {plan.nonGoals.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="section-title">Steps</div>
      {plan.steps.map((step) => (
        <div className="panel" key={step.title}>
          <strong>{step.title}</strong>
          <div className="dim">{step.detail}</div>
        </div>
      ))}
      <div className="section-title">Areas</div>
      <div className="mono dim">{plan.areas.join("  ")}</div>
      <div className="section-title">Acceptance criteria</div>
      <ul className="plain">
        {plan.acceptanceCriteria.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="section-title">Test plan</div>
      <ul className="plain">
        {plan.testPlan.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="section-title">Risks</div>
      <ul className="plain">
        {plan.risks.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {plan.openQuestions.length > 0 ? (
        <>
          <div className="section-title">Open questions</div>
          <ul className="plain">
            {plan.openQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Agents({ task }: { task: Task }) {
  const runs = useStore((s) => taskRuns(s.snapshot, task), shallowArray);
  const tests = useStore(
    (s) =>
      s.snapshot.testResults.filter((t) =>
        s.snapshot.runs.some((r) => r.id === t.runId && r.taskId === task.id),
      ),
    shallowArray,
  );
  const findings = useStore(
    (s) => taskFindings(s.snapshot, task),
    shallowArray,
  );
  const now = useStore((s) => s.snapshot.now);

  return (
    <div className="pad">
      <div className="section-title">Runs</div>
      {runs.length === 0 ? <div className="faint">No runs yet.</div> : null}
      {runs.map((run) => (
        <div className="panel" key={run.id}>
          <div className="detail-meta">
            <span className={`dot ${run.status}`} />
            <strong>{run.role}</strong>
            <span className="chip">{RUN_STATUS_LABELS[run.status]}</span>
            {run.blockedOn ? (
              <span className="chip attention">{run.blockedOn}</span>
            ) : null}
            <span className="chip">{run.provider}</span>
            <span className="chip">{run.mode}</span>
            {run.origin === "external" ? (
              <span className="chip">external</span>
            ) : null}
            <span className="spacer" />
            <span className="faint">
              round {run.round} · attempt {run.attempts}
            </span>
          </div>
          {run.origin === "loom" &&
          run.endReason !== "superseded" &&
          runs.filter((r) => r.origin === "loom" && r.role === run.role).at(-1)
            ?.id === run.id &&
          ((task.stage === "planning" && run.role === "planner") ||
            (task.stage === "in_progress" && run.role === "implementer") ||
            (task.stage === "in_review" && run.role === "reviewer")) ? (
            <RestartRun task={task} run={run} />
          ) : null}
          <dl className="kv" style={{ marginTop: 6 }}>
            <dt>Model</dt>
            <dd className="mono">
              {run.model}
              {run.reasoningEffort ? ` · ${run.reasoningEffort} reasoning` : ""}
            </dd>
            <dt>Session ID</dt>
            <dd className="mono">{run.sessionId ?? "not recorded"}</dd>
            <dt>Session epoch</dt>
            <dd className="nums">{run.sessionEpoch}</dd>
            {run.codexGeneration !== null ? (
              <>
                <dt>Codex generation</dt>
                <dd className="nums">{run.codexGeneration}</dd>
              </>
            ) : null}
            {run.pane ? (
              <>
                <dt>Pane</dt>
                <dd className="mono">
                  {run.pane.sessionName} · {run.pane.paneId}
                </dd>
              </>
            ) : null}
            <dt>Last activity</dt>
            <dd>
              {run.lastActivityAt
                ? `${since(now, run.lastActivityAt)} ago`
                : "never"}
            </dd>
            {run.lastTurn?.error ? (
              <>
                <dt>Last error</dt>
                <dd className="mono">{run.lastTurn.error}</dd>
              </>
            ) : null}
          </dl>
          {run.pendingRequests.map((request) => (
            <div className="panel" key={request.id} style={{ marginTop: 6 }}>
              <span className="chip attention">{request.kind}</span>{" "}
              {request.summary}
              <div className="faint">
                Only the human answers this. {since(now, request.receivedAt)}{" "}
                ago
              </div>
            </div>
          ))}
        </div>
      ))}

      <div className="section-title">Tests</div>
      {tests.map((test) => (
        <div className="panel" key={`${test.command}:${test.ranAt}`}>
          <span
            className={`chip ${test.outcome === "passed" ? "good" : "danger"}`}
          >
            {test.outcome}
          </span>{" "}
          <span className="mono">{test.command}</span>
          <div className="dim">{test.summary}</div>
        </div>
      ))}

      <div className="section-title">Findings</div>
      <div className="dim">
        {findings.length} total ·{" "}
        {
          findings.filter(
            (f) =>
              f.blocking && f.status !== "resolved" && f.status !== "waived",
          ).length
        }{" "}
        open and blocking
      </div>
    </div>
  );
}

function LiveReview({ task }: { task: Task }) {
  const findings = useStore(
    (s) => taskFindings(s.snapshot, task),
    shallowArray,
  );
  return (
    <div className="pad">
      <div className="section-title">Review findings</div>
      {findings.length ? (
        findings.map((f) => (
          <div className="panel" key={f.id}>
            <strong>{f.title}</strong>
            <div>
              {f.severity} · {f.status}
            </div>
            <p>{f.body}</p>
          </div>
        ))
      ) : (
        <div className="faint">No findings in the current snapshot.</div>
      )}
    </div>
  );
}

function RestartRun({ task, run }: { task: Task; run: Run }) {
  const store = useStoreApi();
  const connected = useStore((s) => s.live && s.connection === "connected");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState("");
  const restart = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await store.command({
        kind: "human",
        taskId: task.id,
        command: { type: "restart_run", runId: run.id },
      });
      setOutcome(
        result.ok
          ? "Restart queued. The replacement appears here after the previous agent stops."
          : `${result.error.code}: ${result.error.message}`,
      );
    } catch (error) {
      setOutcome(error instanceof Error ? error.message : "Restart failed");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="panel">
      <button
        type="button"
        disabled={!connected || pending}
        onClick={() => void restart()}
      >
        Restart with current agent settings
      </button>
      <div className="faint">
        Starts a fresh session. Keeps this issue’s worktree, plan and findings.
      </div>
      {outcome ? <div role="status">{outcome}</div> : null}
    </div>
  );
}
