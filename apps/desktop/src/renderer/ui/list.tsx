import { displayName } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, memo, useEffect, useMemo, useRef } from "react";
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

const COLUMNS = "1fr 128px 210px 160px 52px 44px";

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
      <div className="list-head" style={{ ["--cols" as string]: COLUMNS }}>
        {HEADINGS.map((heading) => (
          <button
            key={heading.key}
            type="button"
            onClick={() => store.setSort(heading.key)}
            title={`Sort by ${heading.label.toLowerCase()}`}
          >
            {heading.label}
            {sort === heading.key ? (descending ? " ↓" : " ↑") : ""}
          </button>
        ))}
      </div>
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
                  <button
                    type="button"
                    className="group-header"
                    aria-expanded={!entry.collapsed}
                    onClick={() => store.toggleListSection(entry.stage)}
                    onKeyDown={sectionKeyDown}
                  >
                    <span>
                      {stageLabel(entry.stage)} ·{" "}
                      <span className="faint nums">{entry.count}</span>
                    </span>
                    <span aria-hidden="true">
                      {entry.collapsed ? "▸" : "▾"}
                    </span>
                  </button>
                ) : entry.kind === "load-more" ? (
                  <button
                    type="button"
                    className="list-load-more"
                    onClick={() => store.loadMoreListSection(entry.stage)}
                    onKeyDown={sectionKeyDown}
                  >
                    Load {entry.count} more
                  </button>
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

// Native buttons handle Enter/Space; keep Enter away from the task-open shortcut.
function sectionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
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
    // biome-ignore lint/a11y/noStaticElementInteractions: the keyboard path is j/k then enter, in ui/keys.ts
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is j/k then enter, in ui/keys.ts
    <div
      className="row"
      style={{ ["--cols" as string]: COLUMNS }}
      data-cursor={index === cursor}
      data-task={task.id}
      onClick={() => store.setCursor(index)}
      onDoubleClick={() => store.open(task.id)}
    >
      <div className="cell-title">
        <RunDot run={item.row.run} />
        <span className="id">{issueKeyFor(task, repos)}</span>
        <span
          className="text task-copy"
          title={`${task.title} — ${item.row.summary}`}
        >
          {displayName(task)}
          {item.row.summary ? (
            <span className="task-summary"> — {item.row.summary}</span>
          ) : null}
        </span>
      </div>
      <div className="dim">{stageLabel(task.stage)}</div>
      <div className="cell-title">
        <AttentionChips task={task} />
        {item.row.openBlocking > 0 ? (
          <span className="chip danger">{item.row.openBlocking} blocking</span>
        ) : null}
      </div>
      <ProviderLabel run={item.row.run} runs={item.row.runs} />
      <div className="dim nums">
        {task.reviewRound > 0
          ? `${task.reviewRound}/${task.reviewRoundCap}`
          : "—"}
      </div>
      <div className="faint nums">{age(item.row.ageMinutes)}</div>
    </div>
  );
}

export const ListView = memo(ListViewComponent);
