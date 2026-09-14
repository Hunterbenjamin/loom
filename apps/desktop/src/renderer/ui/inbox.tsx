import { displayName, type Repo } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  INBOX_SECTIONS,
  type InboxRow as InboxRowValue,
  inboxRows,
  REASON_LABELS,
  reasonTab,
} from "../store/inbox.js";
import { useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import { age } from "./format.js";
import { ListGroupHeader, ListRow } from "./list-rows.js";

const reasonGlyph = (reason: string) =>
  reason.includes("approval")
    ? "✓"
    : reason.includes("question") ||
        reason.includes("input") ||
        reason.includes("permission")
      ? "?"
      : "!";

type Item =
  | { kind: "header"; section: (typeof INBOX_SECTIONS)[number]; count: number }
  | { kind: "row"; row: InboxRowValue; index: number };

/** A clock confined to inbox rows: waiting-time updates do not invalidate the task list. */
export const InboxView = memo(function InboxView() {
  const rows = useStore(inboxRows);
  const cursor = useStore((s) => s.ui.cursor);
  const connection = useStore((s) => s.connection);
  const repos = useStore((s) => s.snapshot.repos);
  const parent = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const items: Item[] = useMemo(
    () =>
      INBOX_SECTIONS.flatMap((section) => {
        const sectionRows = rows
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row.section === section.id);
        return sectionRows.length
          ? [
              { kind: "header" as const, section, count: sectionRows.length },
              ...sectionRows.map((item) => ({ kind: "row" as const, ...item })),
            ]
          : [];
      }),
    [rows],
  );
  const list = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 40,
    overscan: 8,
    getItemKey: (index) => {
      const item = items[index];
      return item?.kind === "row" ? item.row.key : `header-${item?.section.id}`;
    },
  });
  const cursorItem = items.findIndex(
    (item) => item.kind === "row" && item.index === cursor,
  );
  useEffect(() => {
    if (cursorItem >= 0) list.scrollToIndex(cursorItem, { align: "auto" });
  }, [cursorItem, list]);
  return (
    <section
      className="inbox reviews-list"
      ref={parent}
      aria-label="Needs you inbox"
    >
      {rows.length === 0 ? (
        <div className="pad faint">
          {connection === "connected" || connection === "fixtures"
            ? "Nothing needs you right now."
            : "Waiting for the coordinator. Issues will appear after connection."}
        </div>
      ) : null}
      <div style={{ height: list.getTotalSize(), position: "relative" }}>
        {list.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          return (
            <div
              key={virtualItem.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {item.kind === "header" ? (
                <ListGroupHeader
                  label={item.section.label}
                  count={item.count}
                  collapsed={false}
                />
              ) : (
                <InboxRow item={item} cursor={cursor} now={now} repos={repos} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
});

function InboxRow({
  item,
  cursor,
  now,
  repos,
}: {
  item: Extract<Item, { kind: "row" }>;
  cursor: number;
  now: number;
  repos: Repo[];
}) {
  const store = useStoreApi();
  const { row, index } = item;
  const run = row.runs[0] ?? null;
  const open = () => {
    store.setCursor(index);
    store.openAttention(
      row.task.id,
      row.reason,
      reasonTab(row.reason, run),
      run?.id ?? null,
    );
  };
  const evidence =
    row.reason === "needs_approval" && row.reviewedHead
      ? row.reviewedHead.slice(0, 7)
      : row.reason === "plan_needs_approval"
        ? row.planVersion == null
          ? null
          : `plan v${row.planVersion}`
        : null;
  return (
    <ListRow
      cursor={index === cursor}
      data-reason={row.reason}
      onOpen={open}
      leading={
        <span
          className={`inbox-glyph ${row.section === "problems" ? "danger" : "attention"}`}
        >
          {reasonGlyph(row.reason)}
        </span>
      }
      text={<span title={row.task.title}>{displayName(row.task)}</span>}
      meta={
        <>
          <span className="pr-task-link mono">
            {issueKeyFor(row.task, repos)}
          </span>
          <span>{REASON_LABELS[row.reason]}</span>
          {evidence ? <span className="mono">{evidence}</span> : null}
        </>
      }
      age={
        row.since
          ? age(Math.max(0, Math.floor((now - Date.parse(row.since)) / 60_000)))
          : "—"
      }
    />
  );
}
