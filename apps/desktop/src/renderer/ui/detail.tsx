import { displayName, type Run, type Task } from "@loom/core";
import { lazy, Suspense } from "react";
import { issueDecisions } from "../store/issue-actions.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor, taskFindings, taskRuns } from "../store/selectors.js";
import type { TabId } from "../store/store.js";
import { AttentionChips } from "./bits.js";
import { clock, RUN_STATUS_LABELS, since, stageLabel } from "./format.js";
import { IssueDecisionPanel } from "./issue-decision-panel.js";
import { useHumanCommand } from "./use-human-command.js";

// Both pull in a large dependency (Pierre, xterm) that the first screen never needs.
const DiffTab = lazy(() =>
  import("./diff.js").then((m) => ({ default: m.DiffTab })),
);
const TerminalTab = lazy(() =>
  import("./terminal.js").then((m) => ({ default: m.TerminalTab })),
);

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "agents", label: "Agents" },
  { id: "terminal", label: "Terminal" },
  { id: "review", label: "Review" },
  { id: "activity", label: "Activity" },
];

export function Detail({ task }: { task: Task }) {
  const store = useStoreApi();
  const live = useStore((s) => s.live);
  const tab = useStore((s) => s.ui.tab);
  const theme = useStore((s) => s.ui.theme);
  const now = useStore((s) => s.snapshot.now);
  const repo = useStore((s) =>
    s.snapshot.repos.find((item) => item.id === task.repoId),
  );
  const linkedPrNumbers = useStore(
    (s) =>
      s.live
        ? (s.inbox.find((row) => row.taskId === task.id)?.linkedPrNumbers ?? [])
        : s.snapshot.pullRequests
            .filter((pr) => pr.repoId === task.repoId && pr.taskId === task.id)
            .map((pr) => pr.number),
    shallowArray,
  );
  const prNumbers = [
    ...new Set([...(task.prNumber ? [task.prNumber] : []), ...linkedPrNumbers]),
  ];

  return (
    <div className="detail pr-detail" data-testid="detail" data-task={task.id}>
      <header className="pr-page-head">
        <div className="pr-breadcrumb">
          <span className="mono faint">
            {issueKeyFor(task, repo ? [repo] : [])}
          </span>
          <span className="faint" aria-hidden="true">
            ›
          </span>
          <span className="faint">●</span>
          <strong className="pr-header-title" title={task.title}>
            {displayName(task)}
          </strong>
          <span className="chip">{stageLabel(task.stage)}</span>
          <AttentionChips task={task} />
        </div>
        {prNumbers.map((number) => (
          <button
            key={number}
            type="button"
            className="pr-github-chip"
            onClick={() =>
              store.openPullRequest({
                repoId: task.repoId,
                number,
              })
            }
          >
            PR #{number}
          </button>
        ))}
        <SecondaryMenu task={task} />
        <button type="button" onClick={() => store.open(null)}>
          Close <kbd>esc</kbd>
        </button>
      </header>
      <div className="issue-meta-line faint">
        <span>{repo?.github}</span>
        {task.branch ? <span className="mono">{task.branch}</span> : null}
        <span>in stage for {since(now, task.stageEnteredAt)}</span>
      </div>
      <div className="pr-toolbar">
        <div className="pr-segments" role="tablist">
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
        <span className="spacer" />
        <ToolbarAction task={task} />
      </div>
      <IssueDecisionPanel task={task} compact={tab === "terminal"} />

      <div className="tab-body pr-page-body" data-tab-body={tab}>
        {tab === "overview" ? <Overview task={task} /> : null}
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

function ToolbarAction({ task }: { task: Task }) {
  const action = useStore(
    (state) =>
      issueDecisions(state, task).decisions.find(
        (decision) => decision.actions.length > 0,
      )?.actions[0],
  );
  const store = useStoreApi();
  const { send, outcome, submitting } = useHumanCommand(task.id);
  if (!action) return null;
  return (
    <div className="issue-toolbar-action">
      <button
        type="button"
        disabled={submitting || !!action.disabledReason}
        title={action.disabledReason ?? undefined}
        onClick={() => {
          if (action.command) void send(action.command());
          else if (action.intent === "terminal") store.setTab("terminal");
        }}
      >
        {action.label}
      </button>
      {action.disabledReason ? (
        <span className="disabled-reason">{action.disabledReason}</span>
      ) : null}
      {outcome.message ? (
        <span className="pr-outcome" role="status">
          {outcome.message}
        </span>
      ) : null}
    </div>
  );
}

function SecondaryMenu({ task }: { task: Task }) {
  const store = useStoreApi();
  const actions = useStore(
    (state) => issueDecisions(state, task).status.secondaryActions,
  );
  const { send, outcome } = useHumanCommand(task.id);
  return (
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
              if (action.intent === "terminal") store.setTab("terminal");
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
  );
}

function Overview({ task }: { task: Task }) {
  const plan = useStore((state) => state.snapshot.plans[task.id]);
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
  const events = useStore(
    (state) =>
      state.snapshot.transitions
        .filter((transition) => transition.taskId === task.id)
        .slice(-5)
        .reverse(),
    shallowArray,
  );
  const store = useStoreApi();
  return (
    <div className="pr-overview issue-overview">
      <main className="pr-story">
        <h1>{displayName(task)}</h1>
        <p className="task-description">
          {task.description.trim() || "No description."}
        </p>
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
        <div className="section-title">Recent activity</div>
        {events.map((event) => (
          <div className="event" key={event.id}>
            <span className="dot" />
            <span>{event.reason}</span>
          </div>
        ))}
        <button type="button" onClick={() => store.setTab("activity")}>
          View all activity
        </button>
      </main>
      <aside className="pr-rail">
        <div className="section-title">Agents</div>
        {runs.map((run) => (
          <div className="panel" key={run.id}>
            <strong>{run.role}</strong> · {run.provider}
            <div className="faint">
              {RUN_STATUS_LABELS[run.status]} ·{" "}
              {run.lastTurn?.outcome ??
                (run.status === "working" ? "working" : "idle")}
            </div>
          </div>
        ))}
        <div className="section-title">Tests</div>
        {tests.length ? (
          tests.map((test) => (
            <div key={`${test.command}:${test.ranAt}`}>
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
      </aside>
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
      {plan.steps.map((step, index) => (
        <div className="panel" key={step.title}>
          <strong>
            {index + 1}. {step.title}
          </strong>
          <div className="dim">{step.detail}</div>
        </div>
      ))}
      <div className="section-title">Areas</div>
      <div className="detail-meta">
        {plan.areas.map((area) => (
          <span className="chip mono" key={area}>
            {area}
          </span>
        ))}
      </div>
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
            <dt>Turn state</dt>
            <dd>
              {run.lastTurn?.error ??
                run.lastTurn?.outcome ??
                (run.status === "working" ? "working" : "idle")}
            </dd>
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
          {run.pendingDialog ? (
            <div className="panel" style={{ marginTop: 6 }}>
              <span className="chip attention">{run.pendingDialog.kind}</span>{" "}
              <span className="mono">{run.pendingDialog.tool}</span>
              <div className="faint">
                {run.pendingDialog.command ?? "Waiting for terminal input"}
              </div>
            </div>
          ) : null}
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
              f.blocking &&
              f.status !== "resolved" &&
              f.status !== "waived" &&
              f.status !== "fixed",
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
        [...findings]
          .sort(
            (a, b) =>
              Number(["resolved", "fixed", "waived"].includes(a.status)) -
              Number(["resolved", "fixed", "waived"].includes(b.status)),
          )
          .map((f) => (
            <div className="panel" key={f.id}>
              <div className="detail-meta">
                <strong>{f.title}</strong>
                <span
                  className={`chip ${f.severity === "blocker" || f.severity === "major" ? "danger" : ""}`}
                >
                  {f.severity}
                </span>
                <span className="chip">{f.status}</span>
                {f.blocking ? (
                  <span className="chip danger">blocking</span>
                ) : null}
              </div>
              {f.location?.path ? (
                <div className="mono faint">
                  {f.location.path}:{f.location.startLine ?? "?"}
                </div>
              ) : null}
              <p style={{ whiteSpace: "pre-wrap" }}>{f.body}</p>
            </div>
          ))
      ) : (
        <div className="faint">No findings in the current snapshot.</div>
      )}
    </div>
  );
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
