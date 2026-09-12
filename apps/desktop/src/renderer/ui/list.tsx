import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { groupRows, type ListItem, selectedRows } from "../store/selectors.js";
import type { SortKey } from "../store/store.js";
import { AttentionChips, ProviderLabel, RunDot } from "./bits.js";
import { age, stageLabel } from "./format.js";

const COLUMNS = "1fr 128px 210px 160px 52px 44px";

const HEADINGS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Task" },
  { key: "stage", label: "Stage" },
  { key: "attention", label: "Attention" },
  { key: "provider", label: "Agent" },
  { key: "round", label: "Round" },
  { key: "age", label: "Age" },
];

function ListViewComponent() {
  const store = useStoreApi();
  const rows = useStore(selectedRows);
  const items = groupRows(rows);
  const cursor = useStore((s) => s.ui.cursor);
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
    getScrollElement: () => scroller.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  // The cursor is an index into `rows`; find where that row landed among the headers.
  const cursorItem = items.findIndex(
    (item) => item.kind === "row" && item.row === rows[cursor],
  );

  useEffect(() => {
    if (cursorItem >= 0) virtual.scrollToIndex(cursorItem, { align: "auto" });
  }, [cursorItem, virtual]);

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
      <div className="list" ref={scroller} data-testid="list">
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
                  <div className="group-header">
                    <span>{stageLabel(entry.stage)}</span>
                    <span className="faint nums">{entry.count}</span>
                  </div>
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
        <span className="id">{task.id}</span>
        <span
          className="text task-copy"
          title={`${task.title} — ${item.row.summary}`}
        >
          {task.title}
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
