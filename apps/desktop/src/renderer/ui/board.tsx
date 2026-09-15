import { displayName, type Stage } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useRef, useState } from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor, type Row, selectedRows } from "../store/selectors.js";
import {
  AttentionChips,
  CiChip,
  CiDot,
  ProviderLabel,
  RunDot,
} from "./bits.js";
import { age, STAGES, since, stageLabel } from "./format.js";

function BoardViewComponent() {
  const rows = useStore(selectedRows);
  const [over, setOver] = useState<Stage | null>(null);
  const store = useStoreApi();

  const byStage = new Map<Stage, Row[]>();
  for (const stage of STAGES) byStage.set(stage, []);
  for (const row of rows) byStage.get(row.task.stage)?.push(row);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse movement switches navigation modality and clears the keyboard cursor
    <div
      className="board"
      data-testid="board"
      onMouseMove={() => {
        if (store.getState().ui.cursor !== null) store.setCursor(null);
      }}
    >
      {STAGES.map((stage) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: a mouse drop target; the keyboard path is `e`
        <section
          key={stage}
          className="column"
          data-stage={stage}
          data-over={over === stage}
          onDragOver={(event) => {
            event.preventDefault();
            if (over !== stage) setOver(stage);
          }}
          onDragLeave={() =>
            setOver((current) => (current === stage ? null : current))
          }
          onDrop={(event) => {
            event.preventDefault();
            setOver(null);
            const id = event.dataTransfer.getData("text/loom-task");
            if (id) store.moveTask(id as Row["task"]["id"], stage);
          }}
        >
          <header className="column-head">
            <span>{stageLabel(stage)}</span>
            <span className="faint nums">
              {byStage.get(stage)?.length ?? 0}
            </span>
          </header>
          <Column rows={byStage.get(stage) ?? []} />
        </section>
      ))}
    </div>
  );
}

function Column({ rows }: { rows: Row[] }) {
  const store = useStoreApi();
  const cursor = useStore((s) => s.ui.cursor);
  const all = useStore(selectedRows);
  const repos = useStore((s) => s.snapshot.repos);
  const now = useStore((s) => s.snapshot.now);
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 84,
    overscan: 6,
  });

  useEffect(() => {
    const selected = all[cursor ?? -1];
    const index = rows.findIndex((row) => row.task.id === selected?.task.id);
    if (index < 0) return;
    virtual.scrollToIndex(index, { align: "auto" });
    scroller.current
      ?.closest(".column")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor, all, rows, virtual]);

  return (
    <div className="column-body" ref={scroller}>
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const index = all.indexOf(row);
          return (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is j/k then enter, in ui/keys.ts */}
              <article
                className="card"
                draggable
                data-task={row.task.id}
                data-cursor={index === cursor}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/loom-task", row.task.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => store.setCursor(index)}
                onDoubleClick={() => store.open(row.task.id)}
              >
                <div className="card-meta">
                  {row.task.stage === "ci" ? (
                    <CiDot ci={row.ci} />
                  ) : (
                    <RunDot run={row.run} />
                  )}
                  <span className="mono">{issueKeyFor(row.task, repos)}</span>
                  <span className="spacer" />
                  <span className="nums">{age(row.ageMinutes)}</span>
                </div>
                <div className="card-title">{displayName(row.task)}</div>
                {row.task.stage === "ci" ? (
                  <div className="card-meta">
                    <CiChip
                      ci={row.ci}
                      elapsed={
                        row.ci
                          ? since(now, row.ci.since)
                          : age(row.stageMinutes)
                      }
                    />
                  </div>
                ) : null}
                {row.summary ? (
                  <div className="card-summary">{row.summary}</div>
                ) : null}
                <div className="card-meta">
                  <ProviderLabel run={row.run} blank />
                  <span className="spacer" />
                  <AttentionChips task={row.task} />
                </div>
              </article>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const BoardView = memo(BoardViewComponent);
