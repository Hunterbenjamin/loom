import type { PullRequestRow } from "@loom/protocol";
import { pullRequestKey } from "@loom/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { selectedPullRequests } from "../store/pull-requests.js";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { since } from "./format.js";

const COLUMNS =
  "minmax(240px, 2fr) minmax(140px, 1fr) 110px 52px 88px 142px 104px";
const CHECKS = {
  success: ["Pass", "good"],
  pending: ["Pending", "attention"],
  failure: ["Fail", "danger"],
  none: ["No checks", ""],
} as const;
const REVIEWS = {
  approved: ["Approved", "good"],
  changes_requested: ["Changes requested", "danger"],
  none: ["None", ""],
} as const;
const MERGEABILITY = {
  mergeable: ["Mergeable", "good"],
  conflicting: ["Conflicts", "danger"],
  unknown: ["Unknown", ""],
} as const;

export function PullRequestsView() {
  const store = useStoreApi();
  const rows = useStore(selectedPullRequests, shallowArray);
  const status = useStore((s) => s.ui.prState);
  const query = useStore((s) => s.ui.prQuery);
  const cursor = useStore((s) => s.ui.prCursor);
  const now = useStore((s) => s.snapshot.now);
  const allRepos = useStore((s) => s.ui.repo === "all");
  const repos = useStore((s) => s.snapshot.repos);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getItemKey: (index) => {
      const row = rows[index] as PullRequestRow;
      return pullRequestKey(row.repoId, row.number);
    },
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 12,
  });
  useEffect(() => {
    const bounded = Math.max(0, Math.min(cursor, rows.length - 1));
    if (bounded !== cursor) store.setPrCursor(bounded);
    if (rows.length) virtual.scrollToIndex(bounded, { align: "auto" });
  }, [cursor, rows.length, store, virtual]);

  return (
    <>
      <div className="pr-filters">
        <div className="segmented">
          {(["open", "merged", "closed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => store.setPrState(value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.stopPropagation();
              }}
            >
              {value[0]?.toUpperCase()}
              {value.slice(1)}
            </button>
          ))}
        </div>
        <input
          className="search"
          data-pr-search
          aria-label="Filter pull requests"
          placeholder="Filter pull requests…"
          value={query}
          onChange={(event) => store.setPrQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              store.setPrQuery("");
              event.currentTarget.blur();
              event.stopPropagation();
            }
          }}
        />
      </div>
      <div className="list" ref={scroller} data-testid="pull-requests-list">
        {rows.length === 0 ? (
          <div className="pad faint" role="status">
            {query.trim()
              ? "No pull requests match this filter."
              : `No ${status} pull requests in the current snapshot.`}
          </div>
        ) : null}
        <table
          className="pr-table"
          aria-label="Pull requests"
          aria-rowcount={rows.length + 1}
        >
          <thead>
            <tr
              className="list-head pr-grid"
              style={{ ["--cols" as string]: COLUMNS }}
            >
              {[
                "Pull request",
                "Branch",
                "Author",
                "Age",
                "Checks",
                "Review",
                "Mergeability",
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            style={{
              display: "block",
              height: virtual.getTotalSize(),
              position: "relative",
            }}
          >
            {virtual.getVirtualItems().map((item) => {
              const pr = rows[item.index] as PullRequestRow;
              const repo = repos.find((repo) => repo.id === pr.repoId);
              return (
                <tr
                  key={item.key}
                  className="row pr-row"
                  aria-rowindex={item.index + 2}
                  tabIndex={item.index === cursor ? 0 : -1}
                  aria-selected={item.index === cursor}
                  data-cursor={item.index === cursor}
                  data-pr={pullRequestKey(pr.repoId, pr.number)}
                  style={{
                    ["--cols" as string]: COLUMNS,
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                  onClick={() => store.setPrCursor(item.index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      store.setPrCursor(item.index);
                    }
                  }}
                >
                  <td className="cell-title">
                    <span className="id" title={repo?.github}>
                      #{pr.number}
                    </span>
                    <span
                      className="text"
                      title={`${allRepos ? `${repo?.github} · ` : ""}${pr.title}`}
                    >
                      {allRepos ? (
                        <span className="faint">{repo?.github} · </span>
                      ) : null}
                      {pr.title}
                    </span>
                    {pr.draft ? <span className="chip">Draft</span> : null}
                    {pr.taskId ? (
                      <button
                        type="button"
                        className="pr-task-link mono"
                        onClick={(event) => {
                          event.stopPropagation();
                          store.open(pr.taskId);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ")
                            event.stopPropagation();
                        }}
                      >
                        {pr.taskId}
                      </button>
                    ) : null}
                  </td>
                  <td className="text dim" title={`${pr.head} → ${pr.base}`}>
                    {pr.head} → {pr.base}
                  </td>
                  <td
                    className="text dim"
                    title={pr.author ?? "Unknown author"}
                  >
                    {pr.author ?? "Unknown"}
                  </td>
                  <td className="faint nums" title={pr.createdAt}>
                    {since(now, pr.createdAt)}
                  </td>
                  <Badge label="Checks" value={CHECKS[pr.checks]} />
                  <Badge label="Review" value={REVIEWS[pr.review]} />
                  <Badge
                    label="Mergeability"
                    value={MERGEABILITY[pr.mergeable]}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Badge({
  label,
  value,
}: {
  label: string;
  value: readonly [string, string];
}) {
  return (
    <td>
      <span
        role="img"
        className={`chip ${value[1]}`}
        aria-label={`${label}: ${value[0]}`}
      >
        {value[0]}
      </span>
    </td>
  );
}
