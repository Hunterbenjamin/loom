import type { PullRequestCommand, PullRequestDetailRow } from "@loom/protocol";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

const Files = lazy(() =>
  import("./diff.js").then((m) => ({ default: m.PullRequestFiles })),
);
type Detail = PullRequestDetailRow["detail"];
type Confirmation =
  | { kind: "merge"; headSha: Detail["headSha"]; base: string }
  | { kind: "close" };
const TABS = ["Description", "Checks", "Files", "Commits"] as const;

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
  const now = useStore((s) => s.snapshot.now);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Description");
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
  const actionBar = useRef<HTMLElement>(null);

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
    if (submitting.current) return;
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
            : "Action completed; GitHub state is shown below.",
      );
    } catch (error) {
      setOutcome(
        error instanceof Error
          ? error.message
          : "Command failed; refresh to check GitHub state.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="detail pr-detail" data-testid="pull-request-detail">
      <header className="detail-head" ref={actionBar}>
        <div className="detail-meta">
          <span className="mono faint">#{selection.number}</span>
          {header ? <span className="chip">{header.state}</span> : null}
          {header?.draft ? <span className="chip">Draft</span> : null}
          <span className="spacer" />
          {header ? (
            <a
              data-pr-action="open"
              aria-keyshortcuts="o"
              href={header.url}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub
            </a>
          ) : null}
          <button type="button" onClick={() => store.openPullRequest(null)}>
            Close detail <kbd>esc</kbd>
          </button>
        </div>
        <h2>{header?.title ?? `Pull request #${selection.number}`}</h2>
        {header ? (
          <div className="detail-meta faint">
            <span className="mono">
              {header.head} → {header.base}
            </span>
            <span>by {header.author ?? "Unknown author"}</span>
          </div>
        ) : null}
        <div className="pr-actions">
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
            Squash and merge
          </button>
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
        </div>
        {reason ? <div className="faint">{reason}</div> : null}
        <div role="status" className="pr-outcome">
          {busy ? "Waiting for GitHub…" : outcome}
          {pr?.mergedAt ? (
            <div>Merged at {pr.mergedAt}</div>
          ) : pr?.state === "closed" ? (
            <div>Pull request closed.</div>
          ) : null}
          {pr?.branchExists === false ? <div>Branch deleted.</div> : null}
        </div>
        {pr ? (
          <div className="faint">Read from GitHub at {pr.observedAt}</div>
        ) : (
          <div className="faint">
            Waiting for detail. Use Refresh to retry if it does not arrive.
          </div>
        )}
      </header>
      <div className="tabs" role="tablist" aria-label="Pull request detail">
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
      <div
        className="tab-body"
        role="tabpanel"
        id="pr-panel"
        aria-labelledby={`pr-tab-${tab}`}
        data-tab-body={tab}
      >
        {pr && row ? (
          <>
            {tab === "Description" ? (
              <div className="pad pr-markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  skipHtml
                  components={{
                    a: ({ children, href }) => (
                      <a href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {pr.body || "No description."}
                </Markdown>
              </div>
            ) : null}
            {tab === "Checks" ? (
              <div className="pad">
                <p>Checks: {pr.checks === "none" ? "No checks" : pr.checks}</p>
                {pr.checkRuns.length ? (
                  <table className="pr-data">
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Status</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pr.checkRuns.map((check) => (
                        <tr key={check.id}>
                          <td>
                            {check.url ? (
                              <a
                                href={check.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {check.name}
                              </a>
                            ) : (
                              check.name
                            )}
                          </td>
                          <td>
                            {check.status}
                            {check.conclusion ? ` · ${check.conclusion}` : ""}
                          </td>
                          <td>
                            {duration(check.startedAt, check.completedAt, now)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="faint">No check runs reported.</p>
                )}
              </div>
            ) : null}
            {tab === "Files" ? (
              <Suspense
                fallback={<div className="pad faint">Loading files…</div>}
              >
                <Files row={row} />
              </Suspense>
            ) : null}
            {tab === "Commits" ? (
              <div className="pad">
                {pr.commits.length ? (
                  pr.commits.map((commit) => (
                    <article className="pr-commit" key={commit.sha}>
                      <a
                        className="mono"
                        href={commit.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {commit.sha.slice(0, 7)}
                      </a>
                      <div className="pr-commit-message">{commit.message}</div>
                      <div className="faint">
                        {commit.author ?? "Unknown author"} ·{" "}
                        {commit.committedAt ?? "Time unavailable"}
                      </div>
                    </article>
                  ))
                ) : (
                  <p>No commits reported.</p>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {confirm ? (
        <ConfirmAction
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

function duration(start: string | null, end: string | null, now: string) {
  if (!start) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(end ?? now) - Date.parse(start)) / 1000),
  );
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s${end ? "" : " · running"}`;
}

function ConfirmAction({
  confirmation,
  title,
  disabled,
  changed,
  onCancel,
  onConfirm,
}: {
  confirmation: Confirmation;
  title: string;
  disabled: boolean;
  changed: boolean;
  onCancel(): void;
  onConfirm(deleteBranch: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
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
