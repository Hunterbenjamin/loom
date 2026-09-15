import { displayName } from "@loom/core";
import type { PullRequestCommand, PullRequestDetailRow } from "@loom/protocol";
import { type ReactNode, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import { since } from "./format.js";
import { PullRequestGlyph as PrGlyph } from "./pull-request-glyph.js";

type Detail = PullRequestDetailRow["detail"];
export function PrMarkdown({ body }: { body: string }) {
  return (
    <div className="pr-markdown">
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
        {body}
      </Markdown>
    </div>
  );
}
export function ChangeCounts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="pr-counts nums">
      <span className="good">+{additions}</span>{" "}
      <span className="danger">−{deletions}</span>
    </span>
  );
}
export function groupPrFiles(files: Detail["files"]) {
  return ["Implementation", "Tests"].map((name) => {
    const members = files.filter(
      (file) =>
        /(?:^|\/)(?:test|tests|__tests__)\/|(?:^|\/)[^/]*\.test\.[^/]+$/.test(
          file.path,
        ) ===
        (name === "Tests"),
    );
    return {
      name,
      files: members,
      additions: members.reduce((sum, file) => sum + file.additions, 0),
      deletions: members.reduce((sum, file) => sum + file.deletions, 0),
    };
  });
}
export function prActivity(pr: Detail) {
  const events = [
    {
      id: "opened",
      at: pr.createdAt,
      label: `Opened by ${pr.author ?? "Unknown author"}`,
      url: pr.url,
      body: "",
      kind: "opened",
    },
    ...pr.commits.map((c) => ({
      id: `commit:${c.sha}`,
      at: c.committedAt,
      label: `${c.author ?? "Unknown author"} committed ${c.sha.slice(0, 7)} · ${c.message.split("\n")[0]}`,
      url: c.url,
      body: "",
      kind: "commit",
    })),
    ...pr.reviews
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: `review:${r.id}`,
        at: r.submittedAt,
        label: `${r.author ?? "Unknown reviewer"} · ${r.state.toLowerCase().replaceAll("_", " ")}`,
        url: r.url,
        body: r.body,
        kind: "review",
      })),
    ...pr.comments.map((c) => ({
      id: `comment:${c.id}`,
      at: c.createdAt,
      label: `${c.author ?? "Unknown author"} commented`,
      url: c.url,
      body: c.body.replace(/\n*<!-- loom-comment:[a-f0-9-]+ -->$/, ""),
      kind: "comment",
    })),
    ...(pr.mergedAt
      ? [
          {
            id: "merged",
            at: pr.mergedAt,
            label: `Merged into ${pr.base}`,
            url: pr.url,
            body: "",
            kind: "merged",
          },
        ]
      : []),
  ];
  return events.sort((a, b) => (a.at ?? "9999").localeCompare(b.at ?? "9999"));
}
export function PullRequestOverview({
  row,
  disabled,
  run,
  onFile,
  issueStory,
  issueRail,
}: {
  issueStory?: ReactNode;
  issueRail?: ReactNode;
  row: PullRequestDetailRow;
  disabled: boolean;
  run(command: PullRequestCommand): Promise<boolean>;
  onFile(path: string): void;
}) {
  const store = useStoreApi();
  const now = useStore((s) => s.snapshot.now);
  const task = useStore((s) =>
    s.snapshot.tasks.find((t) => t.id === row.taskId),
  );
  const repos = useStore((s) => s.snapshot.repos);
  const [linking, setLinking] = useState(false);
  const [key, setKey] = useState("");
  const [comment, setComment] = useState("");
  const commentAttempt = useRef<{ body: string; requestId: string } | null>(
    null,
  );
  const pr = row.detail;
  const selection = { repoId: row.repoId, number: row.number };
  const reviewers = [
    ...new Set([
      ...pr.requestedReviewers,
      ...pr.reviews.flatMap((r) => r.author ?? []),
    ]),
  ];
  const checks = {
    success: "All passed",
    failure: "Checks failed",
    pending: "Checks pending",
    none: "No checks",
  }[pr.checks];
  return (
    <div className="pr-overview">
      <main className="pr-story">
        {issueStory}
        {issueStory ? (
          <h2>
            Pull request #{row.number}: {pr.title}
          </h2>
        ) : (
          <h1>{pr.title}</h1>
        )}
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
        <section className="pr-description">
          <h3>Description</h3>
          <PrMarkdown body={pr.body || "No description."} />
        </section>
        <section className="pr-activity">
          <h3>Activity</h3>
          <ol>
            {prActivity(pr).map((event) => (
              <li
                key={event.id}
                className={event.kind === "commit" ? "pr-commit" : undefined}
              >
                {event.kind === "opened" || event.kind === "merged" ? (
                  <PrGlyph
                    state={event.kind === "merged" ? "merged" : "open"}
                  />
                ) : (
                  <span className="pr-activity-dot" aria-hidden="true">
                    {event.kind === "commit" ? "◇" : "○"}
                  </span>
                )}
                <div>
                  <a href={event.url} target="_blank" rel="noreferrer">
                    {event.label}
                  </a>
                  <span className="faint">
                    {" "}
                    ·{" "}
                    {event.at ? (
                      <time dateTime={event.at} title={event.at}>
                        {since(now, event.at)} ago
                      </time>
                    ) : (
                      "Time unavailable"
                    )}
                  </span>
                  {event.body ? <PrMarkdown body={event.body} /> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
        <form
          className="pr-comment-box"
          onSubmit={async (event) => {
            event.preventDefault();
            if (disabled || !comment.trim()) return;
            const body = comment.trim();
            if (commentAttempt.current?.body !== body)
              commentAttempt.current = { body, requestId: crypto.randomUUID() };
            if (
              await run({
                kind: "comment_pull_request",
                ...selection,
                ...commentAttempt.current,
              })
            ) {
              setComment("");
              commentAttempt.current = null;
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
      </main>
      <aside className="pr-rail" aria-label="Pull request properties">
        {issueRail}
        <section>
          <h3>Status</h3>
          <div className="pr-property">
            <PrGlyph state={pr.state} />
            {pr.state[0]?.toUpperCase()}
            {pr.state.slice(1)}
            {pr.draft ? <span className="chip">Draft</span> : null}
          </div>
        </section>
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
                    ...selection,
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
        <section>
          <h3>Checks</h3>
          <details className="pr-checks">
            <summary>
              <span
                className={
                  pr.checks === "success"
                    ? "good"
                    : pr.checks === "failure"
                      ? "danger"
                      : "faint"
                }
              >
                {pr.checks === "success"
                  ? "✓"
                  : pr.checks === "failure"
                    ? "×"
                    : "●"}
              </span>{" "}
              {checks}
            </summary>
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
          </details>
        </section>
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
        <section className="pr-file-groups">
          <h3>{pr.changedFiles} files changed</h3>
          {groupPrFiles(pr.files)
            .filter((group) => group.files.length)
            .map((group) => (
              <details key={group.name} open>
                <summary>
                  <span>
                    {group.name}{" "}
                    <span className="faint">{group.files.length}</span>
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
      </aside>
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
