import type { PullRequestRow } from "@loom/protocol";
import { pullRequestKey } from "@loom/protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import {
  REVIEW_SECTIONS,
  reviewAgentWorking,
  selectedReviewItems,
} from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import { listItemKey } from "../store/section-list.js";
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

export function PullRequestsView() {
  const store = useStoreApi();
  const ui = useStore((s) => s.ui);
  const items = useStore(selectedReviewItems);
  const loading = useStore((s) =>
    s.pullRequestLists.some(
      (list) => list.repoId === s.ui.repo && list.loading,
    ),
  );
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getItemKey: (index) => listItemKey(items[index]!),
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 12,
  });
  useEffect(() => {
    const bounded =
      ui.prCursor === null || !items.length
        ? null
        : Math.max(0, Math.min(ui.prCursor, items.length - 1));
    if (bounded !== ui.prCursor) store.setPrCursor(bounded);
    if (bounded !== null) virtual.scrollToIndex(bounded, { align: "auto" });
  }, [ui.prCursor, items.length, store, virtual]);

  return (
    <>
      <ListToolbar>
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
        {!loading &&
        items.every((item) => item.kind === "header" && item.count === 0) ? (
          <div className="pad faint" role="status">
            {ui.prTab === "created"
              ? "No pull requests created by you."
              : "No reviews for you."}
          </div>
        ) : null}
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const entry = items[item.index]!;
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
                    cursor={ui.prCursor === item.index}
                    label={
                      REVIEW_SECTIONS.find(
                        (section) => section.id === entry.section,
                      )!.label
                    }
                    count={entry.count}
                    collapsed={entry.collapsed}
                    onToggle={() => store.togglePrSection(entry.section)}
                  />
                ) : entry.kind === "load-more" ? (
                  <LoadMore
                    cursor={ui.prCursor === item.index}
                    label={`Load ${entry.count} more`}
                    onClick={() => store.loadMoreCompletedPrs()}
                  />
                ) : (
                  <ReviewRow
                    pr={entry.row}
                    index={item.index}
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
