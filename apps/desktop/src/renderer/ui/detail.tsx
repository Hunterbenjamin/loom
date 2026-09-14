import {
  displayName,
  type HumanCommand,
  type Run,
  type Sha,
  type Task,
  type TaskId,
} from "@loom/core";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { issueDecisions } from "../store/issue-actions.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor, taskFindings, taskRuns } from "../store/selectors.js";
import type { TabId } from "../store/store.js";
import { AttentionChips } from "./bits.js";
import { clock, RUN_STATUS_LABELS, since, stageLabel } from "./format.js";
import { IssueDecisionPanel } from "./issue-decision-panel.js";
import { PrMarkdown } from "./pull-request-overview.js";
import {
  type HumanCommandOutcome,
  useHumanCommand,
} from "./use-human-command.js";

// xterm is a large dependency that the first screen never needs.
const TerminalTab = lazy(() =>
  import("./terminal.js").then((m) => ({ default: m.TerminalTab })),
);

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "terminal", label: "Terminal" },
];

export function Detail({ task }: { task: Task }) {
  const store = useStoreApi();
  const selectedTab = useStore((s) => s.ui.tab);
  // The Terminal tab exists only while the issue has a live terminal to show.
  const hasTerminal = useStore((s) =>
    s.panes.some((pane) => pane.taskId === task.id && !pane.dead),
  );
  const tab =
    selectedTab === "terminal" && !hasTerminal ? "overview" : selectedTab;
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
  const { send, outcome, submitting, pending } = useHumanCommand(task.id);
  const [confirmHead, setConfirmHead] = useState<Sha | null>(null);
  const [changePlan, setChangePlan] = useState<{ planVersion: number } | null>(
    null,
  );
  const [planDrafts, setPlanDrafts] = useState<Record<TaskId, string>>({});
  const [requestChanges, setRequestChanges] = useState<{
    headSha: string;
  } | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<TaskId, string>>({});
  const planDecision = useStore((state) =>
    issueDecisions(state, task).decisions.find(
      (decision) => decision.kind === "plan_needs_approval",
    ),
  );
  const mergeDecision = useStore((state) =>
    issueDecisions(state, task).decisions.find(
      (decision) => decision.kind === "needs_approval",
    ),
  );
  const reviewedHead = mergeDecision?.reviewedHead;
  const requestCommand = (command: HumanCommand) => {
    if (command.type === "approve") setConfirmHead(command.headSha);
    else void send(command);
  };

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
          {TABS.filter((item) => item.id !== "terminal" || hasTerminal).map(
            (item) => (
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
            ),
          )}
        </div>
        <span className="spacer" />
        <ToolbarAction
          task={task}
          onCommand={requestCommand}
          onChangePlan={() => {
            if (planDecision?.planVersion != null)
              setChangePlan({ planVersion: planDecision.planVersion });
          }}
          onRequestChanges={() => {
            if (reviewedHead) setRequestChanges({ headSha: reviewedHead });
          }}
          outcome={outcome}
          submitting={submitting}
          pending={pending}
        />
      </div>
      <IssueDecisionPanel
        task={task}
        compact={tab === "terminal"}
        onCommand={requestCommand}
        outcome={outcome}
        submitting={submitting}
      />

      <div className="tab-body pr-page-body" data-tab-body={tab}>
        {tab === "overview" ? <Overview task={task} /> : null}
        {tab === "plan" ? <PlanTab task={task} /> : null}
        <Suspense fallback={<div className="pad faint">Loading...</div>}>
          {tab === "terminal" ? (
            <TerminalTab task={task} theme={theme} />
          ) : null}
        </Suspense>
      </div>
      {confirmHead ? (
        <ConfirmIssueApproval
          task={task}
          headSha={confirmHead}
          changed={reviewedHead !== confirmHead}
          disabled={submitting || reviewedHead !== confirmHead}
          onCancel={() => setConfirmHead(null)}
          onConfirm={() => {
            setConfirmHead(null);
            void send({ type: "approve", headSha: confirmHead });
          }}
        />
      ) : null}
      {requestChanges ? (
        <RequestChangesDialog
          task={task}
          capturedHead={requestChanges.headSha}
          currentHead={reviewedHead ?? null}
          action={mergeDecision?.actions.find(
            (action) => action.id === "request-changes",
          )}
          draft={reviewDrafts[task.id] ?? ""}
          submitting={submitting}
          onDraftChange={(draft) =>
            setReviewDrafts((drafts) => ({ ...drafts, [task.id]: draft }))
          }
          onCancel={() => setRequestChanges(null)}
          onSend={async (command) => {
            setRequestChanges(null);
            const result = await send(command);
            if (result?.kind === "queued" || result?.kind === "applied")
              setReviewDrafts((drafts) => ({ ...drafts, [task.id]: "" }));
          }}
        />
      ) : null}
      {changePlan ? (
        <ChangePlanDialog
          task={task}
          capturedPlanVersion={changePlan.planVersion}
          currentPlanVersion={planDecision?.planVersion ?? null}
          planGoal={planDecision?.planGoal ?? null}
          action={planDecision?.actions.find(
            (action) => action.id === "change-plan",
          )}
          draft={planDrafts[task.id] ?? ""}
          submitting={submitting}
          onDraftChange={(draft) =>
            setPlanDrafts((drafts) => ({ ...drafts, [task.id]: draft }))
          }
          onCancel={() => setChangePlan(null)}
          onSend={async (command) => {
            setChangePlan(null);
            const result = await send(command);
            if (result?.kind === "queued" || result?.kind === "applied")
              setPlanDrafts((drafts) => ({ ...drafts, [task.id]: "" }));
          }}
        />
      ) : null}
    </div>
  );
}

function ToolbarAction({
  task,
  onCommand,
  onChangePlan,
  onRequestChanges,
  outcome,
  submitting,
  pending,
}: {
  task: Task;
  onCommand: (command: HumanCommand) => void;
  onChangePlan: () => void;
  onRequestChanges: () => void;
  outcome: HumanCommandOutcome;
  submitting: boolean;
  /** The command in flight: its button shows progress instead of status text. */
  pending: HumanCommand["type"] | null;
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
    ...new Set(
      actions.flatMap((action) =>
        action.disabledReason ? [action.disabledReason] : [],
      ),
    ),
  ];
  return (
    <div className="issue-toolbar-action">
      {actions.map((action) => {
        const loading = busy && commandType(action) === pending;
        return (
          <button
            key={action.id}
            type="button"
            className={secondary.has(action.id) ? "secondary" : undefined}
            disabled={submitting || busy || !!action.disabledReason}
            aria-busy={loading || undefined}
            title={action.disabledReason ?? undefined}
            onClick={() => {
              if (action.id === "change-plan") onChangePlan();
              else if (action.id === "request-changes") onRequestChanges();
              else if (action.command) onCommand(action.command());
              else if (action.intent === "terminal") store.setTab("terminal");
            }}
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

function ChangePlanDialog({
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
      className="create-issue-dialog pr-confirm"
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

function RequestChangesDialog({
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
      className="create-issue-dialog pr-confirm"
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

function ConfirmIssueApproval({
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
      className="create-issue-dialog pr-confirm"
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

function SecondaryMenu({ task }: { task: Task }) {
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
      <aside className="pr-rail">
        <div className="section-title">Agents</div>
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
            runs
              .filter((r) => r.origin === "loom" && r.role === run.role)
              .at(-1)?.id === run.id &&
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
      </aside>
    </div>
  );
}

function useTaskEvents(task: Task) {
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

  return events;
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
