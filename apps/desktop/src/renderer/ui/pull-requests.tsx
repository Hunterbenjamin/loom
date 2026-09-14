import type { PullRequestRow } from "@loom/protocol";
import { pullRequestKey } from "@loom/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { reviewAgentWorking, reviewGroups } from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import { since } from "./format.js";
import { PullRequestGlyph } from "./pull-request-glyph.js";

type Group = ReturnType<typeof reviewGroups>[number];
type Item =
  | { kind: "header"; group: Group }
  | { kind: "more"; group: Group }
  | { kind: "row"; pr: PullRequestRow; cursor: number };

export function PullRequestsView() {
  const store = useStoreApi();
  const ui = useStore((s) => s.ui);
  const prs = useStore((s) => s.snapshot.pullRequests);
  const groups = useMemo(
    () => reviewGroups({ ui, snapshot: { pullRequests: prs } }),
    [ui, prs],
  );
  const loading = useStore((s) =>
    s.pullRequestLists.some(
      (list) => list.repoId === s.ui.repo && list.loading,
    ),
  );
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const items: Item[] = [];
  let cursor = 0;
  for (const group of groups) {
    if (!group.count && group.id !== "completed") continue;
    items.push({ kind: "header", group });
    for (const pr of group.rows)
      items.push({ kind: "row", pr, cursor: cursor++ });
    if (!group.collapsed && group.remaining)
      items.push({ kind: "more", group });
  }
  const virtual = useVirtualizer({
    count: items.length,
    getItemKey: (index) => {
      const item = items[index] as Item;
      return item.kind === "row"
        ? pullRequestKey(item.pr.repoId, item.pr.number)
        : `${item.kind}-${item.group.id}`;
    },
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 12,
  });
  const cursorItem = items.findIndex(
    (item) => item.kind === "row" && item.cursor === ui.prCursor,
  );
  const previousSections = useRef(ui.prSections);
  useEffect(() => {
    const changed = previousSections.current !== ui.prSections;
    previousSections.current = ui.prSections;
    const bounded = Math.max(0, Math.min(ui.prCursor, cursor - 1));
    if (bounded !== ui.prCursor) store.setPrCursor(bounded);
    if (!changed && cursorItem >= 0)
      virtual.scrollToIndex(cursorItem, { align: "auto" });
  }, [ui.prCursor, ui.prSections, cursor, cursorItem, store, virtual]);

  return (
    <>
      <div className="reviews-toolbar">
        <div className="reviews-tabs">
          {(
            [
              ["for-you", "For you"],
              ["created", "Created"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={ui.prTab === value}
              onClick={() => store.setPrTab(value)}
              onKeyDown={buttonKeyDown}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="reviews-search" data-active={!!ui.prQuery}>
          <input
            ref={search}
            data-pr-search
            aria-label="Filter reviews"
            placeholder="Filter reviews…"
            value={ui.prQuery}
            onChange={(e) => store.setPrQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                store.setPrQuery("");
                e.currentTarget.blur();
                e.stopPropagation();
              }
            }}
          />
          <button
            type="button"
            aria-label="Filter reviews"
            title="Filter reviews (/)"
            onClick={() => search.current?.focus()}
            onKeyDown={buttonKeyDown}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M2 4h12M4 8h8M6 12h4" />
            </svg>
          </button>
        </div>
      </div>
      <div
        className="list reviews-list"
        ref={scroller}
        data-testid="pull-requests-list"
      >
        {loading ? (
          <div className="pad faint" role="status">
            Loading reviews…
          </div>
        ) : null}
        {!loading && groups.every((group) => group.count === 0) ? (
          <div className="pad faint" role="status">
            {ui.prQuery.trim()
              ? "No reviews match this filter."
              : ui.prTab === "created"
                ? "No pull requests created by you."
                : "No reviews for you."}
          </div>
        ) : null}
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const entry = items[item.index] as Item;
            return (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {entry.kind === "header" ? (
                  <button
                    type="button"
                    className="reviews-group"
                    aria-expanded={!entry.group.collapsed}
                    onClick={() => store.togglePrSection(entry.group.id)}
                    onKeyDown={buttonKeyDown}
                  >
                    <span>{entry.group.label}</span>
                    <span className="nums">{entry.group.count}</span>
                    <span aria-hidden="true">
                      {entry.group.collapsed ? "▸" : "▾"}
                    </span>
                  </button>
                ) : entry.kind === "more" ? (
                  <button
                    type="button"
                    className="list-load-more"
                    onClick={() => store.loadMoreCompletedPrs()}
                    onKeyDown={buttonKeyDown}
                  >
                    Load {Math.min(20, entry.group.remaining)} more
                  </button>
                ) : (
                  <ReviewRow
                    pr={entry.pr}
                    index={entry.cursor}
                    cursor={ui.prCursor}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function buttonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

function ReviewRow({
  pr,
  index,
  cursor,
}: {
  pr: PullRequestRow;
  index: number;
  cursor: number;
}) {
  const store = useStoreApi();
  const now = useStore((s) => s.snapshot.now);
  const working = useStore((s) => reviewAgentWorking(s, pr));
  const linkedTask = useStore((s) =>
    pr.taskId
      ? s.snapshot.tasks.find((task) => task.id === pr.taskId)
      : undefined,
  );
  const repos = useStore((s) => s.snapshot.repos);
  const linkedIssue = linkedTask ? issueKeyFor(linkedTask, repos) : pr.taskId;
  const status = working
    ? ["Agent working", "ϟ", "working"]
    : pr.checks === "failure"
      ? ["Checks failed", "×", "danger"]
      : pr.checks === "pending"
        ? ["Checks pending", "●", "attention"]
        : pr.checks === "success"
          ? ["All checks passed", "✓", "good"]
          : null;
  const open = () => {
    store.setPrCursor(index);
    store.openPullRequest({ repoId: pr.repoId, number: pr.number });
  };
  return (
    <div
      className="review-row"
      data-cursor={index === cursor}
      data-pr={pullRequestKey(pr.repoId, pr.number)}
    >
      <button
        type="button"
        className="review-row-open"
        tabIndex={index === cursor ? 0 : -1}
        onClick={open}
        onKeyDown={buttonKeyDown}
        title={pr.title}
      >
        <PullRequestGlyph state={pr.state} />
        <span className="text">{pr.title}</span>
      </button>
      {pr.taskId ? (
        <button
          type="button"
          className="pr-task-link mono"
          onClick={() => store.open(pr.taskId)}
          onKeyDown={buttonKeyDown}
          title={`Open issue ${linkedIssue}`}
        >
          {linkedIssue}
        </button>
      ) : null}
      <span
        className={`review-status ${status?.[2] ?? ""}`}
        role="img"
        aria-label={status?.[0] ?? "No checks"}
        title={status?.[0]}
      >
        {status?.[1]}
      </span>
      <span className="faint nums review-age" title={pr.createdAt}>
        {since(now, pr.createdAt)}
      </span>
    </div>
  );
}
