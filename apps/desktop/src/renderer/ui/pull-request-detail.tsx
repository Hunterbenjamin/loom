import type { PullRequestCommand, PullRequestDetailRow } from "@loom/protocol";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { selectedDetailTask } from "../store/detail-selection.js";
import {
  deleteDisabledReason,
  mergeDisabledReason,
} from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import type { UiState } from "../store/ui-state.js";
import { Detail as IssueDetail } from "./detail.js";
import { DetailLayout } from "./detail-layout.js";
import { Overview } from "./overview.js";
import { PullRequestGlyph as PrGlyph } from "./pull-request-glyph.js";
import { ChangeCounts } from "./pull-request-overview.js";
import { useTrackerActions } from "./tracker-actions.js";
import { keyHint } from "./tracker-keymap.js";
import { usePullRequestCommand } from "./use-pull-request-command.js";

const Files = lazy(() =>
  import("./pull-request-diff.js").then((m) => ({
    default: m.PullRequestDiff,
  })),
);
type Detail = PullRequestDetailRow["detail"];
type Confirmation =
  | { kind: "merge"; headSha: Detail["headSha"]; base: string }
  | { kind: "close" };
const TABS = ["Overview", "Diff"] as const;

export function PullRequestDetail({
  selection,
}: {
  selection: NonNullable<UiState["openPr"]>;
}) {
  const store = useStoreApi();
  const row = useStore((s) =>
    s.pullRequestDetails.find(
      (r) => r.repoId === selection.repoId && r.number === selection.number,
    ),
  );
  const summary = useStore((s) =>
    s.snapshot.pullRequests.find(
      (r) => r.repoId === selection.repoId && r.number === selection.number,
    ),
  );
  const connection = useStore((s) => s.connection !== "connected");
  const task = useStore((s) => selectedDetailTask(s, selection));
  const [file, setFile] = useState<string | null>(null);
  const [deleteAfterMerge, setDeleteAfterMerge] = useState(true);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const { run: sendPr, busy, submitting, outcome } = usePullRequestCommand();
  const run = (command: PullRequestCommand) => {
    setConfirm(null);
    return sendPr(command);
  };
  const pr = row?.detail;
  const header = pr ?? summary;
  const showMergeAction = header?.state !== "merged";
  const reason = connection
    ? "Disconnected from the coordinator."
    : pr
      ? mergeDisabledReason(pr)
      : "Waiting for pull request detail.";
  const displayedReason =
    reason === "The pull request is not open." ? null : reason;
  const deleteReason = pr
    ? deleteDisabledReason(pr)
    : "Waiting for pull request detail.";
  const merge = () => {
    if (!busy && !reason && pr && !submitting.current)
      setConfirm({ kind: "merge", headSha: pr.headSha, base: pr.base });
  };
  const deleteBranch = () => {
    if (!busy && !connection && !deleteReason)
      void run({ kind: "delete_branch", ...selection });
  };
  const refresh = () => {
    if (!busy && !connection)
      void run({
        kind: "refresh_pull_requests",
        repoId: selection.repoId,
        state: pr?.state ?? "open",
      });
  };
  useTrackerActions(
    task
      ? {}
      : {
          "tab-overview": () => setTab("Overview"),
          "tab-diff": () => setTab("Diff"),
          merge,
          delete: deleteBranch,
          refresh,
          github: () => {
            if (header)
              window.open(header.url, "_blank", "noopener,noreferrer");
          },
        },
  );

  if (task)
    return <IssueDetail key={task.id} task={task} selection={selection} />;

  return (
    <DetailLayout
      testId="pull-request-detail"
      onClose={() => store.openPullRequest(null)}
      tab={tab}
      breadcrumb={
        <>
          <span className="faint">No issue</span>
          <span className="faint">›</span>
          {header ? <PrGlyph state={header.state} /> : null}
          <span className="pr-header-title" title={header?.title}>
            {header?.title ?? `Pull request #${selection.number}`}
          </span>
        </>
      }
      actions={
        <>
          {pr ? <ChangeCounts {...pr} /> : null}
          <button
            type="button"
            className="pr-icon-button"
            aria-label={row?.pinned ? "Unpin pull request" : "Pin pull request"}
            aria-pressed={row?.pinned ?? false}
            disabled={!!busy || connection || !pr}
            onClick={() =>
              void run({
                kind: "pin_pull_request",
                ...selection,
                pinned: !row?.pinned,
              })
            }
          >
            {row?.pinned ? "★" : "☆"}
          </button>
          <details className="pr-menu">
            <summary aria-label="More pull request actions">•••</summary>
            <div className="pr-menu-items">
              <button
                type="button"
                data-pr-action="delete"
                {...keyHint("delete", deleteReason)}
                disabled={!!busy || connection || !!deleteReason}
                onClick={deleteBranch}
              >
                Delete branch
              </button>
              <button
                type="button"
                disabled={!!busy || connection || pr?.state !== "open"}
                onClick={() => setConfirm({ kind: "close" })}
              >
                Close
              </button>
              <button
                type="button"
                data-pr-action="refresh"
                {...keyHint("refresh")}
                disabled={!!busy || connection}
                onClick={refresh}
              >
                Refresh
              </button>
            </div>
          </details>
          {header ? (
            <a
              className="pr-github-chip mono"
              data-pr-action="open"
              {...keyHint("github")}
              aria-label="Open on GitHub"
              href={header.url}
              target="_blank"
              rel="noreferrer"
            >
              <PrGlyph state={header.state} />
              loom#{selection.number}
            </a>
          ) : null}
        </>
      }
      toolbar={
        <>
          <div
            className="pr-segments"
            role="tablist"
            aria-label="Pull request detail"
          >
            {TABS.map((label) => (
              <button
                key={label}
                type="button"
                role="tab"
                id={`pr-tab-${label}`}
                {...keyHint(label === "Overview" ? "tab-overview" : "tab-diff")}
                data-tab={label === "Overview" ? "overview" : "diff"}
                aria-controls="detail-panel"
                aria-selected={tab === label}
                onClick={() => setTab(label)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {showMergeAction ? (
            <div className="pr-merge-split">
              <button
                type="button"
                data-pr-action="merge"
                {...keyHint("merge", reason)}
                disabled={!!busy || !!reason}
                onClick={merge}
              >
                Squash &amp; merge
              </button>
              <details className="pr-menu">
                <summary aria-label="Merge options">⌄</summary>
                <div className="pr-menu-items">
                  <label>
                    <input
                      type="checkbox"
                      checked={deleteAfterMerge}
                      onChange={(event) =>
                        setDeleteAfterMerge(event.target.checked)
                      }
                    />
                    Delete branch after merge
                  </label>
                </div>
              </details>
            </div>
          ) : null}
        </>
      }
      dialogs={
        confirm ? (
          <ConfirmAction
            initialDeleteBranch={deleteAfterMerge}
            confirmation={confirm}
            title={header?.title ?? `#${selection.number}`}
            disabled={
              !!busy ||
              (confirm.kind === "merge"
                ? !!reason ||
                  confirm.headSha !== pr?.headSha ||
                  confirm.base !== pr?.base
                : connection || pr?.state !== "open")
            }
            changed={
              confirm.kind === "merge" &&
              (confirm.headSha !== pr?.headSha || confirm.base !== pr?.base)
            }
            onCancel={() => setConfirm(null)}
            onConfirm={(deleteBranch) =>
              void run(
                confirm.kind === "merge"
                  ? {
                      kind: "merge_pull_request",
                      ...selection,
                      matchHeadSha: confirm.headSha,
                      deleteBranch,
                    }
                  : { kind: "close_pull_request", ...selection },
              )
            }
          />
        ) : null
      }
    >
      {displayedReason || outcome || busy ? (
        <div className="pr-feedback">
          <span className="faint">{displayedReason}</span>
          <div role="status" className="pr-outcome">
            {busy ?? outcome}
          </div>
        </div>
      ) : null}
      {pr?.branchExists === false ? (
        <div className="pr-observed faint">Branch deleted.</div>
      ) : null}
      {pr && row ? (
        tab === "Overview" ? (
          <Overview
            row={row}
            disabled={!!busy || connection}
            run={run}
            onFile={(path) => {
              setFile(path);
              setTab("Diff");
            }}
          />
        ) : (
          <Suspense fallback={<div className="pad faint">Loading files…</div>}>
            <Files row={row} selectedFile={file} />
          </Suspense>
        )
      ) : (
        <div className="pad faint">
          Waiting for detail. Use Refresh to retry if it does not arrive.
        </div>
      )}
    </DetailLayout>
  );
}

function ConfirmAction({
  initialDeleteBranch,
  confirmation,
  title,
  disabled,
  changed,
  onCancel,
  onConfirm,
}: {
  initialDeleteBranch: boolean;
  confirmation: Confirmation;
  title: string;
  disabled: boolean;
  changed: boolean;
  onCancel(): void;
  onConfirm(deleteBranch: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleteBranch, setDeleteBranch] = useState(initialDeleteBranch);
  const merge = confirmation.kind === "merge";
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
      aria-labelledby="pr-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="pr-confirm-title">
        {merge ? "Squash and merge" : "Close pull request"}
      </h2>
      <p>{title}</p>
      {merge ? (
        <>
          <p>
            Merge head <code>{confirmation.headSha}</code> into{" "}
            <strong>{confirmation.base}</strong>.
          </p>
          <label className="issue-toggle">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(event) => setDeleteBranch(event.target.checked)}
            />
            Delete branch after merge
          </label>
        </>
      ) : (
        <p>Close this pull request on GitHub?</p>
      )}
      {changed ? (
        <p role="alert">
          The head or base changed. Cancel and review the refreshed pull request
          before confirming.
        </p>
      ) : null}
      <div className="pr-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onConfirm(deleteBranch)}
        >
          {merge ? "Confirm squash merge" : "Confirm close"}
        </button>
      </div>
    </dialog>
  );
}
