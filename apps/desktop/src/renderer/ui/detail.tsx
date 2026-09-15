import type { HumanCommand, Sha, Task, TaskId } from "@loom/core";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { issuePrNumbers } from "../store/detail-selection.js";
import { issueDecisions } from "../store/issue-actions.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import type { TabId, UiState } from "../store/ui-state.js";
import { AttentionChips } from "./bits.js";
import { DetailLayout } from "./detail-layout.js";
import { EditBacklogIssue } from "./edit-backlog-issue.js";
import { stageLabel } from "./format.js";
import { IssueDecisionPanel } from "./issue-decision-panel.js";
import {
  ChangePlanDialog,
  ConfirmIssueApproval,
  RequestChangesDialog,
} from "./issue-dialogs.js";
import { IssuePlanTab } from "./issue-plan-tab.js";
import { IssueSecondaryMenu } from "./issue-secondary-menu.js";
import { IssueToolbarAction } from "./issue-toolbar-action.js";
import { Overview } from "./overview.js";
import {
  PULL_REQUEST_ACTION_EVENT,
  type PullRequestActionRequest,
} from "./pull-request-commands.js";
import { ChangeCounts } from "./pull-request-overview.js";
import { useHumanCommand } from "./use-human-command.js";
import { usePullRequestCommand } from "./use-pull-request-command.js";

// xterm is a large dependency that the first screen never needs.
const TerminalTab = lazy(() =>
  import("./terminal.js").then((m) => ({ default: m.TerminalTab })),
);

const Files = lazy(() =>
  import("./pull-request-diff.js").then((m) => ({
    default: m.PullRequestDiff,
  })),
);
const BranchDiff = lazy(() =>
  import("./branch-diff.js").then((m) => ({ default: m.BranchDiff })),
);

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
];

export function Detail({
  task,
  selection,
}: {
  task: Task;
  selection?: NonNullable<UiState["openPr"]>;
}) {
  const store = useStoreApi();
  const selectedTab = useStore((s) => s.ui.tab);
  // The Terminal tab exists only while the issue has a live terminal to show.
  const hasTerminal = useStore((s) =>
    s.panes.some((pane) => pane.taskId === task.id && !pane.dead),
  );
  const plan = useStore((s) => s.snapshot.plans[task.id]);
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const { run, busy, outcome: prOutcome } = usePullRequestCommand();
  const disconnected = useStore((s) => s.connection !== "connected");
  const theme = useStore((s) => s.ui.theme);
  const repo = useStore((s) =>
    s.snapshot.repos.find((item) => item.id === task.repoId),
  );
  const prNumbers = useStore((s) => issuePrNumbers(s, task), shallowArray);
  const prNumber = selection?.number ?? prNumbers[0];
  const row = useStore((s) =>
    s.pullRequestDetails.find(
      (r) => r.repoId === task.repoId && r.number === prNumber,
    ),
  );
  const hasDiff = !!prNumber || !!task.branch;
  const tabs = TABS.filter(
    (item) =>
      item.id === "overview" ||
      (item.id === "plan" && !!plan) ||
      (item.id === "diff" && hasDiff) ||
      (item.id === "terminal" && hasTerminal),
  );
  const tab = tabs.some((item) => item.id === selectedTab)
    ? selectedTab
    : "overview";
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
  const approvalUnavailableReason =
    (selection && !row) ||
    (prNumber !== undefined && task.prNumber !== prNumber) ||
    (row && row.detail.headSha !== reviewedHead)
      ? "This PR is not the issue’s reviewed head. Review the issue’s current PR before approving."
      : null;
  const actionBar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const activate = (event: Event) => {
      const request = (event as CustomEvent<PullRequestActionRequest>).detail;
      if (
        request.repoId !== task.repoId ||
        request.number !== prNumber ||
        document.querySelector("dialog[open]")
      )
        return;
      actionBar.current
        ?.querySelector<HTMLElement>(`[data-pr-action="${request.action}"]`)
        ?.click();
    };
    window.addEventListener(PULL_REQUEST_ACTION_EVENT, activate);
    return () =>
      window.removeEventListener(PULL_REQUEST_ACTION_EVENT, activate);
  }, [task.repoId, prNumber]);
  const requestCommand = (command: HumanCommand) => {
    if (command.type === "approve") setConfirmHead(command.headSha);
    else void send(command);
  };

  return (
    <DetailLayout
      testId="detail"
      taskId={task.id}
      tab={tab}
      actionRef={actionBar}
      onClose={() =>
        selection ? store.openPullRequest(null) : store.open(null)
      }
      breadcrumb={
        <>
          <span className="mono faint">
            {issueKeyFor(task, repo ? [repo] : [])}
          </span>
          <span className="faint" aria-hidden="true">
            ›
          </span>
          <span className="faint">●</span>
          <strong className="pr-header-title" title={task.title}>
            {task.title}
          </strong>
          <span className="chip">{stageLabel(task.stage)}</span>
          <AttentionChips task={task} />
        </>
      }
      actions={
        <>
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
          {row ? (
            <>
              <ChangeCounts {...row.detail} />
              <button
                type="button"
                className="pr-icon-button"
                aria-label={
                  row.pinned ? "Unpin pull request" : "Pin pull request"
                }
                aria-pressed={row.pinned}
                disabled={!!busy || disconnected}
                onClick={() =>
                  void run({
                    kind: "pin_pull_request",
                    repoId: row.repoId,
                    number: row.number,
                    pinned: !row.pinned,
                  })
                }
              >
                {row.pinned ? "★" : "☆"}
              </button>
              <a
                className="pr-github-chip mono"
                data-pr-action="open"
                aria-label="Open on GitHub"
                href={row.detail.url}
                target="_blank"
                rel="noreferrer"
              >
                #{row.number} ↗
              </a>
            </>
          ) : null}
          {prNumber ? (
            <button
              type="button"
              data-pr-action="refresh"
              disabled={!!busy || disconnected}
              onClick={() =>
                void run({
                  kind: "refresh_pull_requests",
                  repoId: task.repoId,
                  state: row?.detail.state ?? "open",
                })
              }
            >
              Refresh
            </button>
          ) : null}
          <IssueSecondaryMenu task={task} />
        </>
      }
      banner={
        <IssueDecisionPanel
          task={task}
          compact={tab === "terminal"}
          onCommand={requestCommand}
          outcome={outcome}
          submitting={submitting}
        />
      }
      toolbar={
        <>
          <div className="pr-segments" role="tablist">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-controls="detail-panel"
                aria-selected={tab === item.id}
                data-tab={item.id}
                onClick={() => store.setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {task.stage === "backlog" ? (
            <div className="issue-toolbar-action">
              <button
                type="button"
                className="secondary"
                disabled={disconnected || submitting || pending !== null}
                data-issue-action="edit"
                onClick={() => setEditing(true)}
              >
                Edit issue
              </button>
              <button
                type="button"
                disabled={disconnected || submitting || pending !== null}
                aria-busy={pending === "move" || undefined}
                data-issue-action="todo"
                onClick={() => void send({ type: "move", to: "todo" })}
              >
                {pending === "move" ? (
                  <span className="button-spinner" aria-hidden="true" />
                ) : null}
                Move to Todo
              </button>
              {/* Progress shows on the button; only a refusal needs words. */}
              {outcome.kind === "refused" ? (
                <span className="pr-outcome danger" role="alert">
                  {outcome.message}
                </span>
              ) : null}
            </div>
          ) : null}
          <IssueToolbarAction
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
            approvalUnavailableReason={approvalUnavailableReason}
          />
        </>
      }
      dialogs={
        <>
          {editing ? (
            <EditBacklogIssue
              key={task.id}
              task={task}
              onClose={() => setEditing(false)}
            />
          ) : null}
          {confirmHead ? (
            <ConfirmIssueApproval
              task={task}
              headSha={confirmHead}
              changed={
                reviewedHead !== confirmHead || !!approvalUnavailableReason
              }
              disabled={
                submitting ||
                reviewedHead !== confirmHead ||
                !!approvalUnavailableReason
              }
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
        </>
      }
    >
      {prOutcome || busy ? (
        <div className="pr-feedback" role="status">
          {busy ?? prOutcome}
        </div>
      ) : null}
      {tab === "overview" ? (
        <>
          {prNumber && !row ? (
            <div className="pad faint">Loading pull request #{prNumber}…</div>
          ) : null}
          <Overview
            task={task}
            row={row}
            disabled={!!busy || disconnected}
            run={run}
            onFile={(path) => {
              setFile(path);
              store.setTab("diff");
            }}
          />
        </>
      ) : null}
      {tab === "plan" ? <IssuePlanTab task={task} /> : null}
      <Suspense fallback={<div className="pad faint">Loading…</div>}>
        {tab === "diff" ? (
          prNumber ? (
            row ? (
              <Files row={row} selectedFile={file} />
            ) : (
              <div className="pad faint">Loading pull request diff…</div>
            )
          ) : (
            <BranchDiff task={task} />
          )
        ) : null}
        {tab === "terminal" ? <TerminalTab task={task} theme={theme} /> : null}
      </Suspense>
    </DetailLayout>
  );
}
