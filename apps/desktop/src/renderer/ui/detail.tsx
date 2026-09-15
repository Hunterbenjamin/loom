import {
  displayName,
  type HumanCommand,
  type Sha,
  type Task,
  type TaskId,
} from "@loom/core";
import { lazy, Suspense, useState } from "react";
import { issueDecisions } from "../store/issue-actions.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import type { TabId } from "../store/store.js";
import { AttentionChips } from "./bits.js";
import { since, stageLabel } from "./format.js";
import { IssueDecisionPanel } from "./issue-decision-panel.js";
import {
  ChangePlanDialog,
  ConfirmIssueApproval,
  RequestChangesDialog,
} from "./issue-dialogs.js";
import { IssueOverview } from "./issue-overview.js";
import { IssuePlanTab } from "./issue-plan-tab.js";
import { IssueSecondaryMenu } from "./issue-secondary-menu.js";
import { IssueToolbarAction } from "./issue-toolbar-action.js";
import { useHumanCommand } from "./use-human-command.js";

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
        <IssueSecondaryMenu task={task} />
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
        {tab === "overview" ? <IssueOverview task={task} /> : null}
        {tab === "plan" ? <IssuePlanTab task={task} /> : null}
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
