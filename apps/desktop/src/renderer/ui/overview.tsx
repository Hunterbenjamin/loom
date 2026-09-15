import { displayName, type Run, sumTokenUsage, type Task } from "@loom/core";
import type { PullRequestCommand, PullRequestDetailRow } from "@loom/protocol";
import { type ReactNode, useRef, useState } from "react";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor, taskFindings, taskRuns } from "../store/selectors.js";
import { ActivityList } from "./activity.js";
import {
  formatTokenUsage,
  RUN_STATUS_LABELS,
  since,
  stageLabel,
} from "./format.js";
import { PullRequestGlyph as PrGlyph } from "./pull-request-glyph.js";
import {
  ChangeCounts,
  groupPrFiles,
  PrMarkdown,
  prActivity,
} from "./pull-request-overview.js";
import { useHumanCommand } from "./use-human-command.js";
import { useTaskEvents } from "./use-task-events.js";

/**
 * The Overview tab for an issue, its pull request, or both together: one reading column and one
 * property rail, never an issue page stacked on a pull request page.
 */
export function Overview({
  task,
  row,
  disabled,
  run,
  onFile,
}: {
  task?: Task;
  row?: PullRequestDetailRow;
  disabled: boolean;
  run(command: PullRequestCommand): Promise<boolean>;
  onFile(path: string): void;
}) {
  const pr = row?.detail;
  const title = task?.title ?? pr?.title ?? "";
  return (
    <div className="pr-overview">
      <main className="pr-story">
        <h1>{title}</h1>
        {pr ? (
          <div className="pr-byline">
            <span className="pr-avatar">
              {(pr.author ?? "?").slice(0, 2).toUpperCase()}
            </span>
            <span>{pr.author ?? "Unknown author"}</span>
            <span className="faint">·</span>
            <span className="mono faint" title={`${pr.base} ← ${pr.head}`}>
              {pr.base} ← {pr.head}
            </span>
          </div>
        ) : null}
        {task ? (
          <section className="pr-description">
            <h3>Description</h3>
            <PrMarkdown body={task.description.trim() || "No description."} />
          </section>
        ) : null}
        {pr ? (
          <section className="pr-description">
            <h3>{task ? "Pull request description" : "Description"}</h3>
            <PrMarkdown body={pr.body || "No description."} />
          </section>
        ) : null}
        {task?.stage === "ci" ? <CiProgress task={task} /> : null}
        {task ? <Findings task={task} /> : null}
        {task ? (
          <IssueActivity task={task} row={row} />
        ) : row ? (
          <ActivityList items={prActivity(row.detail)} />
        ) : null}
        {row ? <CommentBox row={row} disabled={disabled} run={run} /> : null}
      </main>
      <aside className="pr-rail" aria-label="Properties">
        <section>
          <h3>Status</h3>
          <div className="pr-property overview-status">
            {task ? (
              <span className="chip">{stageLabel(task.stage)}</span>
            ) : null}
            {pr ? (
              <span className="overview-status-pr">
                <PrGlyph state={pr.state} />
                {pr.state[0]?.toUpperCase()}
                {pr.state.slice(1)}
                {pr.draft ? <span className="chip">Draft</span> : null}
              </span>
            ) : null}
          </div>
        </section>
        {row && !task ? (
          <LinkIssue row={row} disabled={disabled} run={run} />
        ) : null}
        {row ? <Reviewers row={row} /> : null}
        {row ? <Checks row={row} /> : null}
        {task ? <Agents task={task} /> : null}
        {task ? <Tests task={task} /> : null}
        {row ? <Branch row={row} /> : null}
        {row ? <Files row={row} onFile={onFile} /> : null}
      </aside>
    </div>
  );
}

/** The issue's own activity and its pull request's, in one timeline. */
function IssueActivity({
  task,
  row,
}: {
  task: Task;
  row?: PullRequestDetailRow;
}) {
  const events = useTaskEvents(task);
  return (
    <ActivityList
      items={row ? [...events, ...prActivity(row.detail)] : events}
    />
  );
}

function CiProgress({ task }: { task: Task }) {
  const now = useStore((state) => state.snapshot.now);
  const ci = useStore(
    (state) => state.inbox.find((row) => row.taskId === task.id)?.ci ?? null,
  );
  return (
    <section className="pr-description" data-testid="ci-status">
      <h3>CI</h3>
      <div className="detail-meta">
        <strong>Commit {ci?.headSha.slice(0, 7) ?? "unknown"}</strong>
        <span className="chip">{ci?.conclusion ?? "waiting"}</span>
        <span className="spacer" />
        <span className="faint">
          {ci ? `${since(now, ci.since)} since submission` : "Submitted"}
        </span>
      </div>
      {ci?.checks.length ? (
        ci.checks.map((check) => (
          <div className="detail-meta" key={`${check.name}:${check.url ?? ""}`}>
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
    </section>
  );
}

function Findings({ task }: { task: Task }) {
  const findings = useStore(
    (state) => taskFindings(state.snapshot, task),
    shallowArray,
  );
  const settled = (status: string) =>
    ["resolved", "fixed", "waived"].includes(status);
  const sorted = [...findings].sort(
    (a, b) =>
      Number(settled(a.status)) - Number(settled(b.status)) ||
      Number(b.blocking) - Number(a.blocking),
  );
  const blocking = findings.filter(
    (f) => f.blocking && !settled(f.status),
  ).length;
  const open = findings.filter((f) => !settled(f.status)).length;
  if (!findings.length) return null;
  // Collapsed unless something still blocks the issue; each finding opens on its own.
  return (
    <details className="overview-findings" open={blocking > 0}>
      <summary>
        <h3>Findings</h3>
        <span className="faint">
          {blocking
            ? `${blocking} blocking`
            : open
              ? `${open} open`
              : "all settled"}
          {" · "}
          {findings.length} total
        </span>
      </summary>
      {sorted.map((f) => (
        <details
          className={`panel issue-finding ${settled(f.status) ? "settled" : ""}`}
          key={f.id}
          open={f.blocking && !settled(f.status)}
        >
          <summary className="detail-meta">
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
          </summary>
          {f.location?.path ? (
            <div className="mono faint">
              {f.location.path}:{f.location.startLine ?? "?"}
            </div>
          ) : null}
          <PrMarkdown body={f.body} />
        </details>
      ))}
    </details>
  );
}

function CommentBox({
  row,
  disabled,
  run,
}: {
  row: PullRequestDetailRow;
  disabled: boolean;
  run(command: PullRequestCommand): Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const attempt = useRef<{ body: string; requestId: string } | null>(null);
  return (
    <form
      className="pr-comment-box"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || !comment.trim()) return;
        const body = comment.trim();
        if (attempt.current?.body !== body)
          attempt.current = { body, requestId: crypto.randomUUID() };
        if (
          await run({
            kind: "comment_pull_request",
            repoId: row.repoId,
            number: row.number,
            ...attempt.current,
          })
        ) {
          setComment("");
          attempt.current = null;
        }
      }}
    >
      <textarea
        aria-label="PR comment"
        placeholder="Leave a comment…"
        value={comment}
        disabled={disabled}
        onChange={(event) => setComment(event.target.value)}
        rows={2}
      />
      <button
        type="submit"
        aria-label="Post comment"
        title="Post comment"
        disabled={disabled || !comment.trim()}
      >
        ↑
      </button>
    </form>
  );
}

function LinkIssue({
  row,
  disabled,
  run,
}: {
  row: PullRequestDetailRow;
  disabled: boolean;
  run(command: PullRequestCommand): Promise<boolean>;
}) {
  const store = useStoreApi();
  const task = useStore((s) =>
    s.snapshot.tasks.find((t) => t.id === row.taskId),
  );
  const repos = useStore((s) => s.snapshot.repos);
  const [linking, setLinking] = useState(false);
  const [key, setKey] = useState("");
  return (
    <section>
      <h3>Resolves</h3>
      {task ? (
        <button
          type="button"
          className="pr-property"
          onClick={() => store.open(task.id)}
        >
          {issueKeyFor(task, repos)}{" "}
          <span className="faint">{displayName(task)}</span>
        </button>
      ) : linking ? (
        <form
          className="pr-link-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              key.trim() &&
              (await run({
                kind: "link_pull_request",
                repoId: row.repoId,
                number: row.number,
                taskKey: key,
              }))
            )
              setLinking(false);
          }}
        >
          <input
            aria-label="Issue key"
            placeholder="LOOM-123"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" disabled={disabled || !key.trim()}>
            Link
          </button>
          <button type="button" onClick={() => setLinking(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          className="pr-property faint"
          type="button"
          disabled={disabled}
          onClick={() => setLinking(true)}
        >
          ＋ Link issue
        </button>
      )}
    </section>
  );
}

function Reviewers({ row }: { row: PullRequestDetailRow }) {
  const pr = row.detail;
  const reviewers = [
    ...new Set([
      ...pr.requestedReviewers,
      ...pr.reviews.flatMap((r) => r.author ?? []),
    ]),
  ];
  return (
    <section>
      <h3>Reviewers</h3>
      {reviewers.map((reviewer) => (
        <div className="pr-property" key={reviewer}>
          <span className="pr-avatar">
            {reviewer.slice(0, 2).toUpperCase()}
          </span>
          {reviewer}
        </div>
      ))}
      <button
        type="button"
        className="pr-property faint"
        disabled
        title="Adding reviewers is not available in v1"
      >
        ＋ Add reviewers
      </button>
    </section>
  );
}

/** Line icons for the rail's expandable rows, drawn like `PullRequestGlyph`. */
const RAIL_ICONS: Record<"checks" | "agents" | "tests", ReactNode> = {
  checks: (
    <>
      <path d="M1.5 3.5l1.2 1.2 2.3-2.4M1.5 8l1.2 1.2L5 6.8M1.5 12.5l1.2 1.2L5 11.3" />
      <path d="M8 3.5h6.5M8 8h6.5M8 12.5h6.5" />
    </>
  ),
  agents: (
    <>
      <rect x="2.5" y="5" width="11" height="8.5" rx="2.5" />
      <path d="M8 2v3M6 9v1M10 9v1" />
    </>
  ),
  tests: (
    <>
      <path d="M6 1.75h4M6.75 1.75v4.5L3 12.9a1 1 0 0 0 .87 1.35h8.26a1 1 0 0 0 .87-1.35L9.25 6.25v-4.5" />
      <path d="M4.6 10h6.8" />
    </>
  ),
};

/**
 * A rail row whose summary opens to its detail. Like the rest of the rail it shows an icon and
 * a label, colored by state, with no disclosure arrow.
 */
function Collapsible({
  title,
  tone,
  icon,
  summary,
  children,
  testId,
}: {
  title: string;
  tone: "good" | "danger" | "faint";
  icon: keyof typeof RAIL_ICONS;
  summary: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <h3>{title}</h3>
      <details className="pr-checks">
        <summary className="pr-property">
          <svg
            className={`rail-icon ${tone}`}
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {RAIL_ICONS[icon]}
          </svg>
          {summary}
        </summary>
        {children}
      </details>
    </section>
  );
}

function Checks({ row }: { row: PullRequestDetailRow }) {
  const now = useStore((s) => s.snapshot.now);
  const pr = row.detail;
  return (
    <Collapsible
      title="Checks"
      tone={
        pr.checks === "success"
          ? "good"
          : pr.checks === "failure"
            ? "danger"
            : "faint"
      }
      icon="checks"
      summary={
        {
          success: "All passed",
          failure: "Checks failed",
          pending: "Checks pending",
          none: "No checks",
        }[pr.checks]
      }
    >
      <table className="pr-data">
        <tbody>
          {pr.checkRuns.map((check) => (
            <tr key={check.id}>
              <td>
                {check.url ? (
                  <a href={check.url} target="_blank" rel="noreferrer">
                    {check.name}
                  </a>
                ) : (
                  check.name
                )}
                <div className="faint">
                  {check.status}
                  {check.conclusion ? ` · ${check.conclusion}` : ""}
                </div>
                <div className="faint">
                  {duration(check.startedAt, check.completedAt, now)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!pr.checkRuns.length ? (
        <p className="faint">No check runs reported.</p>
      ) : null}
    </Collapsible>
  );
}

function Agents({ task }: { task: Task }) {
  const runs = useStore(
    (state) => taskRuns(state.snapshot, task),
    shallowArray,
  );
  const now = useStore((state) => state.snapshot.now);
  const working = runs.filter((run) => run.status === "working");
  const live = runs.filter((run) => !run.endedAt);
  const hasTokenUsage = runs.some((run) => run.tokenUsage?.length);
  return (
    <Collapsible
      title="Agents"
      testId="overview-agents"
      tone={working.length ? "good" : "faint"}
      icon="agents"
      summary={
        working.length
          ? working.map((run) => `${run.role} working`).join(", ")
          : live.length
            ? live
                .map(
                  (run) =>
                    `${run.role} ${RUN_STATUS_LABELS[run.status].toLowerCase()}`,
                )
                .join(", ")
            : runs.length
              ? `${runs.length} ${runs.length === 1 ? "run" : "runs"} finished`
              : "No runs yet"
      }
    >
      {hasTokenUsage ? (
        <div className="faint" data-testid="issue-token-usage">
          Total tokens · {formatTokenUsage(sumTokenUsage(runs))}
        </div>
      ) : null}
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
    </Collapsible>
  );
}

function Tests({ task }: { task: Task }) {
  const tests = useStore(
    (state) =>
      state.snapshot.testResults.filter((test) =>
        state.snapshot.runs.some(
          (run) => run.id === test.runId && run.taskId === task.id,
        ),
      ),
    shallowArray,
  );
  const failed = tests.filter((test) => test.outcome !== "passed").length;
  const passed = tests.length - failed;
  return (
    <Collapsible
      title="Tests"
      testId="overview-tests"
      tone={!tests.length ? "faint" : failed ? "danger" : "good"}
      icon="tests"
      summary={
        !tests.length
          ? "No test results yet"
          : failed
            ? `${failed} failed · ${passed} passed`
            : `${passed} passed`
      }
    >
      {tests.map((test) => (
        <div key={`${test.command}:${test.ranAt}`} title={test.summary}>
          <span
            className={`chip ${test.outcome === "passed" ? "good" : "danger"}`}
          >
            {test.outcome}
          </span>{" "}
          <span className="mono">{test.command}</span>
        </div>
      ))}
    </Collapsible>
  );
}

function Branch({ row }: { row: PullRequestDetailRow }) {
  const pr = row.detail;
  return (
    <section>
      <h3>Branch</h3>
      <div className="pr-property">
        <span aria-hidden="true">⑂</span>
        {pr.mergeable === "conflicting"
          ? "Conflicts"
          : row.behindBy === null
            ? "Comparison unavailable"
            : row.behindBy === 0
              ? "Up to date"
              : `Behind ${pr.base} by ${row.behindBy}`}
      </div>
    </section>
  );
}

function Files({
  row,
  onFile,
}: {
  row: PullRequestDetailRow;
  onFile(path: string): void;
}) {
  const pr = row.detail;
  return (
    <section className="pr-file-groups">
      <h3>{pr.changedFiles} files changed</h3>
      {groupPrFiles(pr.files)
        .filter((group) => group.files.length)
        .map((group) => (
          <details key={group.name} open>
            <summary>
              <span>
                {group.name} <span className="faint">{group.files.length}</span>
              </span>
              <ChangeCounts {...group} />
            </summary>
            <div className="pr-group-files">
              {group.files.map((file) => {
                const index = file.path.lastIndexOf("/");
                return (
                  <button
                    type="button"
                    key={file.path}
                    title={file.path}
                    onClick={() => onFile(file.path)}
                  >
                    <span className="pr-file-name">
                      {file.path.slice(index + 1)}{" "}
                      <span className="faint">
                        {file.path.slice(0, index + 1)}
                      </span>
                    </span>
                    <ChangeCounts {...file} />
                  </button>
                );
              })}
            </div>
          </details>
        ))}
    </section>
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

function duration(start: string | null, end: string | null, now: string) {
  if (!start) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(end ?? now) - Date.parse(start)) / 1000),
  );
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s${end ? "" : " · running"}`;
}
