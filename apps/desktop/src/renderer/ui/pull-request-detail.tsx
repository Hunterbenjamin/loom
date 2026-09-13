import type { PullRequestCommand, PullRequestDetailRow } from "@loom/protocol";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  deleteDisabledReason,
  mergeDisabledReason,
} from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import type { UiState } from "../store/store.js";
import {
  PULL_REQUEST_ACTION_EVENT,
  type PullRequestActionRequest,
} from "./pull-request-commands.js";
import { PullRequestGlyph as PrGlyph } from "./pull-request-glyph.js";
import { ChangeCounts, PullRequestOverview } from "./pull-request-overview.js";

const Files = lazy(() =>
  import("./diff.js").then((m) => ({ default: m.PullRequestFiles })),
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
  const connection = useStore((s) => s.live && s.connection !== "connected");
  const task = useStore((s) =>
    s.snapshot.tasks.find((t) => t.id === (row?.taskId ?? summary?.taskId)),
  );
  const agent = useStore((s) =>
    s.snapshot.runs.find(
      (r) =>
        r.taskId === task?.id &&
        r.status !== "ended" &&
        r.endedAt === null &&
        r.mode === "interactive",
    ),
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [deleteAfterMerge, setDeleteAfterMerge] = useState(true);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [outcome, setOutcome] = useState("");
  const pr = row?.detail;
  const header = pr ?? summary;
  const reason = connection
    ? "Disconnected from the coordinator."
    : pr
      ? mergeDisabledReason(pr)
      : "Waiting for pull request detail.";
  const deleteReason = pr
    ? deleteDisabledReason(pr)
    : "Waiting for pull request detail.";
  const actionBar = useRef<HTMLDivElement>(null);

  // Palette and shortcuts activate the same guarded native controls as a click.
  useEffect(() => {
    const activate = (event: Event) => {
      const request = (event as CustomEvent<PullRequestActionRequest>).detail;
      if (
        request.repoId !== selection.repoId ||
        request.number !== selection.number ||
        submitting.current ||
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
  }, [selection.repoId, selection.number]);

  async function run(command: PullRequestCommand) {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    setOutcome("");
    setConfirm(null);
    try {
      const ack = await store.command(command);
      setOutcome(
        !ack.ok
          ? `${ack.error.code}: ${ack.error.message}${ack.error.details.length ? `\n${ack.error.details.join("\n")}` : ""}`
          : command.kind === "refresh_pull_requests"
            ? "Refreshed from GitHub."
            : command.kind === "pin_pull_request"
              ? command.pinned
                ? "Pull request pinned."
                : "Pull request unpinned."
              : command.kind === "link_pull_request"
                ? "Issue linked."
                : "Action completed; GitHub state is shown below.",
      );
      return ack.ok;
    } catch (error) {
      setOutcome(
        error instanceof Error
          ? error.message
          : "Command failed; refresh to check GitHub state.",
      );
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="detail pr-detail"
      data-fullscreen={fullscreen}
      data-testid="pull-request-detail"
      ref={actionBar}
    >
      <header className="pr-page-head">
        <div className="pr-breadcrumb">
          {task ? (
            <button type="button" onClick={() => store.open(task.id)}>
              {task.id}
            </button>
          ) : (
            <span className="faint">No issue</span>
          )}
          <span className="faint">›</span>
          {header ? <PrGlyph state={header.state} /> : null}
          <span className="pr-header-title" title={header?.title}>
            {header?.title ?? `Pull request #${selection.number}`}
          </span>
        </div>
        {pr ? <ChangeCounts {...pr} /> : null}
        <button
          type="button"
          className="pr-icon-button"
          aria-label={row?.pinned ? "Unpin pull request" : "Pin pull request"}
          aria-pressed={row?.pinned ?? false}
          disabled={busy || connection || !pr}
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
              aria-keyshortcuts="d"
              disabled={busy || connection || !!deleteReason}
              title={deleteReason ?? undefined}
              onClick={() => void run({ kind: "delete_branch", ...selection })}
            >
              Delete branch
            </button>
            <button
              type="button"
              disabled={busy || connection || pr?.state !== "open"}
              onClick={() => setConfirm({ kind: "close" })}
            >
              Close
            </button>
            <button
              type="button"
              data-pr-action="refresh"
              aria-keyshortcuts="r"
              disabled={busy || connection}
              onClick={() =>
                void run({
                  kind: "refresh_pull_requests",
                  repoId: selection.repoId,
                  state: pr?.state ?? "open",
                })
              }
            >
              Refresh
            </button>
            <button type="button" onClick={() => store.openPullRequest(null)}>
              Close detail
            </button>
          </div>
        </details>
        {header ? (
          <a
            className="pr-github-chip mono"
            data-pr-action="open"
            aria-keyshortcuts="o"
            aria-label="Open on GitHub"
            href={header.url}
            target="_blank"
            rel="noreferrer"
          >
            <PrGlyph state={header.state} />
            loom#{selection.number}
          </a>
        ) : null}
        <button
          type="button"
          className="pr-icon-button"
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-pressed={fullscreen}
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? "↙" : "⛶"}
        </button>
      </header>
      <div className="pr-toolbar">
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
              aria-controls="pr-panel"
              aria-selected={tab === label}
              onClick={() => setTab(label)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="pr-merge-split">
          <button
            type="button"
            data-pr-action="merge"
            aria-keyshortcuts="m"
            disabled={busy || !!reason}
            title={reason ?? undefined}
            onClick={() =>
              pr &&
              setConfirm({ kind: "merge", headSha: pr.headSha, base: pr.base })
            }
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
        <button
          type="button"
          className="pr-run-agent"
          aria-label="Open branch agent"
          title={agent ? "Open branch agent" : "No Loom agent on this branch"}
          disabled={!agent || !task}
          onClick={() => {
            if (task && agent) {
              store.open(task.id);
              store.setRun(agent.id);
              store.setTab("terminal");
            }
          }}
        >
          ⚑
        </button>
      </div>
      <div
        className="tab-body pr-page-body"
        role="tabpanel"
        id="pr-panel"
        aria-labelledby={`pr-tab-${tab}`}
        data-tab-body={tab}
      >
        {reason || outcome || busy ? (
          <div className="pr-feedback">
            <span className="faint">{reason}</span>
            <div role="status" className="pr-outcome">
              {busy ? "Waiting for coordinator…" : outcome}
            </div>
          </div>
        ) : null}
        {pr?.mergedAt ? (
          <div className="pr-observed faint">
            Merged at {pr.mergedAt}
            {pr.branchExists === false ? " · Branch deleted." : ""}
          </div>
        ) : pr?.branchExists === false ? (
          <div className="pr-observed faint">Branch deleted.</div>
        ) : null}
        {pr && row ? (
          tab === "Overview" ? (
            <PullRequestOverview
              row={row}
              disabled={busy || connection}
              run={run}
              onFile={(path) => {
                setFile(path);
                setTab("Diff");
              }}
            />
          ) : (
            <Suspense
              fallback={<div className="pad faint">Loading files…</div>}
            >
              {row.patchError ? (
                <div className="pad" role="alert">
                  {row.patchError}
                </div>
              ) : null}
              {row.patch ? (
                <Files row={{ ...row, patch: row.patch }} selectedFile={file} />
              ) : row.patchLoading ? (
                <div className="pad faint" role="status">
                  Loading diff…
                </div>
              ) : null}
            </Suspense>
          )
        ) : (
          <div className="pad faint">
            Waiting for detail. Use Refresh to retry if it does not arrive.
          </div>
        )}
      </div>
      {confirm ? (
        <ConfirmAction
          initialDeleteBranch={deleteAfterMerge}
          confirmation={confirm}
          title={header?.title ?? `#${selection.number}`}
          disabled={
            busy ||
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
      ) : null}
    </div>
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
