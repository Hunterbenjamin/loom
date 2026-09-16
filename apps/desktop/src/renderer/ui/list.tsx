import { displayName } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useRef } from "react";
import { finishedKey } from "../store/pane-transitions.js";
import { useStore, useStoreApi } from "../store/react.js";
import {
  issueKeyFor,
  type ListItem,
  listItemKey,
  selectedListItems,
} from "../store/selectors.js";
import type { SortKey } from "../store/ui-state.js";
import {
  AttentionChips,
  CiChip,
  CiDot,
  ProviderLabel,
  RunDot,
} from "./bits.js";
import { age, duration, since, stageLabel } from "./format.js";
import { ListGroupHeader, ListRow, LoadMore } from "./list-rows.js";

const HEADINGS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Issue" },
  { key: "stage", label: "Stage" },
  { key: "attention", label: "Attention" },
  { key: "provider", label: "Agent" },
  { key: "round", label: "Round" },
  { key: "time", label: "Time" },
];

function ListViewComponent() {
  const store = useStoreApi();
  const items = useStore(selectedListItems);
  const cursor = useStore((s) => s.ui.cursor);
  const selectionVersion = useStore((s) => s.ui.selectionVersion);
  const sort = useStore((s) => s.ui.sort);
  const descending = useStore((s) => s.ui.descending);
  const scroller = useRef<HTMLDivElement>(null);

  const virtual = useVirtualizer({
    count: items.length,
    getItemKey: (index) => {
      const item = items[index] as ListItem;
      return listItemKey(item);
    },
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 12,
    // The sticky column headings sit above the rows inside the same scroller.
    scrollPaddingStart: 28,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit selection must scroll even when its index is unchanged.
  useEffect(() => {
    if (cursor !== null) virtual.scrollToIndex(cursor, { align: "auto" });
  }, [cursor, virtual, selectionVersion]);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse movement switches navigation modality and clears the keyboard cursor */}
      <div
        className="list issues-list"
        ref={scroller}
        data-testid="list"
        onMouseMove={() => {
          if (cursor !== null) store.setCursor(null);
        }}
      >
        {/* Column headings name each column and sort by it; rows share the same grid. */}
        <div className="list-head issues-list-head">
          {HEADINGS.map((heading) => (
            <button
              key={heading.key}
              type="button"
              className={`issues-col-${heading.key}`}
              onClick={() => store.setSort(heading.key)}
              title={`Sort by ${heading.label.toLowerCase()}`}
            >
              {heading.label}
              {sort === heading.key ? (descending ? " ↓" : " ↑") : ""}
            </button>
          ))}
        </div>
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
                    cursor={cursor === item.index}
                    label={`${stageLabel(entry.stage)} · `}
                    count={entry.count}
                    collapsed={entry.collapsed}
                    onToggle={() => store.toggleListSection(entry.stage)}
                  />
                ) : entry.kind === "load-more" ? (
                  <LoadMore
                    cursor={cursor === item.index}
                    label={`Load ${entry.count} more`}
                    onClick={() => store.loadMoreListSection(entry.stage)}
                  />
                ) : (
                  <Row index={item.index} item={entry} cursor={cursor} />
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
  cursor: number | null;
}) {
  const store = useStoreApi();
  const { task } = item.row;
  const repos = useStore((s) => s.snapshot.repos);
  const now = useStore((s) => s.snapshot.now);
  const run = item.row.run;
  const read = useStore((s) => !!run && s.readFinished.has(finishedKey(run)));
  return (
    <ListRow
      cursor={index === cursor}
      data-task={task.id}
      onOpen={() => {
        store.setCursor(index);
        store.open(task.id);
      }}
      leading={
        task.stage === "ci" ? (
          <CiDot ci={item.row.ci} />
        ) : (
          <RunDot run={run} stage={task.stage} read={read} />
        )
      }
      title={`${task.title} — ${item.row.summary}`}
      text={
        <span className="issue-line">
          <span className="id mono">{issueKeyFor(task, repos)}</span>
          <span className="task-copy">
            {displayName(task)}
            {item.row.summary ? (
              <span className="task-summary"> — {item.row.summary}</span>
            ) : null}
          </span>
        </span>
      }
      meta={
        <>
          <span className="issues-col-stage list-stage dim">
            {stageLabel(task.stage)}
          </span>
          <span className="issues-col-attention">
            <AttentionChips task={task} />
            {task.stage === "ci" ? (
              <CiChip
                ci={item.row.ci}
                elapsed={
                  item.row.ci
                    ? since(now, item.row.ci.since)
                    : age(item.row.stageMinutes)
                }
              />
            ) : null}
            {item.row.openBlocking > 0 ? (
              <span className="chip danger">
                {item.row.openBlocking} blocking
              </span>
            ) : null}
          </span>
          <span className="issues-col-provider list-provider">
            <ProviderLabel run={item.row.run} runs={item.row.runs} />
          </span>
          <span className="issues-col-round dim nums list-round">
            {task.reviewRound > 0
              ? `${task.reviewRound}/${task.reviewRoundCap}`
              : "—"}
          </span>
        </>
      }
      age={
        item.row.workMinutes === null ? (
          <span title="Not started">—</span>
        ) : (
          <span
            className={item.row.working ? "work-running" : undefined}
            title={
              item.row.working
                ? `In progress for ${duration(item.row.workMinutes)}`
                : `${duration(item.row.workMinutes)} from In progress to ready to merge`
            }
          >
            {duration(item.row.workMinutes)}
          </span>
        )
      }
    />
  );
}

export const ListView = memo(ListViewComponent);
