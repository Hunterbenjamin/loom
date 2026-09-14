import { displayName } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import {
  cursorRows,
  issueKeyFor,
  type ListItem,
  selectedListItems,
} from "../store/selectors.js";
import type { SortKey } from "../store/store.js";
import { AttentionChips, ProviderLabel, RunDot } from "./bits.js";
import { age, stageLabel } from "./format.js";
import {
  ListGroupHeader,
  ListRow,
  ListToolbar,
  LoadMore,
} from "./list-rows.js";

const HEADINGS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Issue" },
  { key: "stage", label: "Stage" },
  { key: "attention", label: "Attention" },
  { key: "provider", label: "Agent" },
  { key: "round", label: "Round" },
  { key: "age", label: "Age" },
];

function ListViewComponent() {
  const store = useStoreApi();
  const rows = useStore(cursorRows);
  const items = useStore(selectedListItems);
  const cursor = useStore((s) => s.ui.cursor);
  const sections = useStore((s) => s.ui.listSections);
  const previousSections = useRef(sections);
  const selectionVersion = useStore((s) => s.ui.selectionVersion);
  const previousSelection = useRef(selectionVersion);
  const sort = useStore((s) => s.ui.sort);
  const descending = useStore((s) => s.ui.descending);
  const scroller = useRef<HTMLDivElement>(null);
  // Built once per render so a scroll frame never does a linear scan per visible row.
  const indexOfRow = useMemo(
    () => new Map(rows.map((row, index) => [row, index])),
    [rows],
  );

  const virtual = useVirtualizer({
    count: items.length,
    getItemKey: (index) => {
      const item = items[index] as ListItem;
      return item.kind === "row"
        ? item.row.task.id
        : `${item.kind}-${item.stage}`;
    },
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 12,
  });

  // The cursor is an index into `rows`; find where that row landed among the headers.
  const cursorItem = items.findIndex(
    (item) => item.kind === "row" && item.row === rows[cursor],
  );

  useEffect(() => {
    // Toggling a section must not scroll back to the reset task cursor.
    const sectionsChanged = previousSections.current !== sections;
    previousSections.current = sections;
    const selectionChanged = previousSelection.current !== selectionVersion;
    previousSelection.current = selectionVersion;
    if ((!sectionsChanged || selectionChanged) && cursorItem >= 0)
      virtual.scrollToIndex(cursorItem, { align: "auto" });
  }, [cursorItem, virtual, sections, selectionVersion]);

  return (
    <>
      <ListToolbar>
        <label className="list-sort">
          <span className="faint">Sort</span>
          <select
            aria-label="Sort issues"
            value={sort}
            onChange={(event) => store.setSort(event.target.value as SortKey)}
          >
            {HEADINGS.map((heading) => (
              <option key={heading.key} value={heading.key}>
                {heading.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label="Toggle sort direction"
          title="Toggle sort direction"
          onClick={() => store.setSort(sort)}
        >
          {descending ? "↓" : "↑"}
        </button>
      </ListToolbar>
      <div className="list issues-list" ref={scroller} data-testid="list">
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const entry = items[item.index] as ListItem;
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
                    label={`${stageLabel(entry.stage)} · `}
                    count={entry.count}
                    collapsed={entry.collapsed}
                    onToggle={() => store.toggleListSection(entry.stage)}
                  />
                ) : entry.kind === "load-more" ? (
                  <LoadMore
                    label={`Load ${entry.count} more`}
                    onClick={() => store.loadMoreListSection(entry.stage)}
                  />
                ) : (
                  <Row
                    index={indexOfRow.get(entry.row) ?? 0}
                    item={entry}
                    cursor={cursor}
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

function Row({
  item,
  index,
  cursor,
}: {
  item: Extract<ListItem, { kind: "row" }>;
  index: number;
  cursor: number;
}) {
  const store = useStoreApi();
  const { task } = item.row;
  const repos = useStore((s) => s.snapshot.repos);
  return (
    <ListRow
      cursor={index === cursor}
      data-task={task.id}
      onOpen={() => {
        store.setCursor(index);
        store.open(task.id);
      }}
      leading={<RunDot run={item.row.run} />}
      title={`${task.title} — ${item.row.summary}`}
      text={
        <>
          <span className="id mono">{issueKeyFor(task, repos)}</span>
          <span className="task-copy">
            {displayName(task)}
            {item.row.summary ? (
              <span className="task-summary"> — {item.row.summary}</span>
            ) : null}
          </span>
        </>
      }
      meta={
        <>
          <AttentionChips task={task} />
          {item.row.openBlocking > 0 ? (
            <span className="chip danger">
              {item.row.openBlocking} blocking
            </span>
          ) : null}
          <span className="chip list-stage">{stageLabel(task.stage)}</span>
          <span className="list-provider">
            <ProviderLabel run={item.row.run} runs={item.row.runs} />
          </span>
          {task.reviewRound > 0 ? (
            <span className="dim nums list-round">
              {task.reviewRound}/{task.reviewRoundCap}
            </span>
          ) : null}
        </>
      }
      age={age(item.row.ageMinutes)}
    />
  );
}

export const ListView = memo(ListViewComponent);
