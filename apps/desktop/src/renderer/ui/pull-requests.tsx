import type { PullRequestRow } from "@loom/protocol";
import { pullRequestKey } from "@loom/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { reviewAgentWorking, reviewGroups } from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import { since } from "./format.js";
import {
  ListGroupHeader,
  ListRow,
  ListToolbar,
  LoadMore,
  stopButtonShortcut,
} from "./list-rows.js";
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
    const bounded =
      ui.prCursor === null
        ? null
        : cursor === 0
          ? null
          : Math.max(0, Math.min(ui.prCursor, cursor - 1));
    if (bounded !== ui.prCursor) store.setPrCursor(bounded);
    if (!changed && cursorItem >= 0)
      virtual.scrollToIndex(cursorItem, { align: "auto" });
  }, [ui.prCursor, ui.prSections, cursor, cursorItem, store, virtual]);

  return (
    <>
      <ListToolbar
        query={ui.prQuery}
        onQuery={store.setPrQuery}
        inputRef={search}
        label="Filter reviews"
      >
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
            onKeyDown={stopButtonShortcut}
          >
            {label}
          </button>
        ))}
      </ListToolbar>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse movement switches navigation modality and clears the keyboard cursor */}
      <div
        className="list reviews-list"
        ref={scroller}
        data-testid="pull-requests-list"
        onMouseMove={() => {
          if (ui.prCursor !== null) store.setPrCursor(null);
        }}
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
                  <ListGroupHeader
                    label={entry.group.label}
                    count={entry.group.count}
                    collapsed={entry.group.collapsed}
                    onToggle={() => store.togglePrSection(entry.group.id)}
                  />
                ) : entry.kind === "more" ? (
                  <LoadMore
                    label={`Load ${Math.min(20, entry.group.remaining)} more`}
                    onClick={() => store.loadMoreCompletedPrs()}
                  />
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

function ReviewRow({
  pr,
  index,
  cursor,
}: {
  pr: PullRequestRow;
  index: number;
  cursor: number | null;
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
    <ListRow
      cursor={index === cursor}
      onOpen={open}
      leading={<PullRequestGlyph state={pr.state} />}
      text={pr.title}
      title={pr.title}
      data-pr={pullRequestKey(pr.repoId, pr.number)}
      age={since(now, pr.createdAt)}
      meta={
        <span
          className={`review-status ${status?.[2] ?? ""}`}
          role="img"
          aria-label={status?.[0] ?? "No checks"}
          title={status?.[0]}
        >
          {status?.[1]}
        </span>
      }
    >
      {pr.taskId ? (
        <button
          type="button"
          className="pr-task-link mono"
          onClick={(event) => {
            event.stopPropagation();
            store.open(pr.taskId);
          }}
          onKeyDown={stopButtonShortcut}
          title={`Open issue ${linkedIssue}`}
        >
          {linkedIssue}
        </button>
      ) : null}
    </ListRow>
  );
}
