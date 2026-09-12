import type { Stage } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useRef, useState } from "react";
import { STAGES } from "../fixtures/index.js";
import { useStore, useStoreApi } from "../store/react.js";
import { type Row, selectedRows } from "../store/selectors.js";
import { AttentionChips, ProviderLabel, RunDot } from "./bits.js";
import { age, stageLabel } from "./format.js";

function BoardViewComponent() {
  const rows = useStore(selectedRows);
  const [over, setOver] = useState<Stage | null>(null);
  const store = useStoreApi();

  const byStage = new Map<Stage, Row[]>();
  for (const stage of STAGES) byStage.set(stage, []);
  for (const row of rows) byStage.get(row.task.stage)?.push(row);

  return (
    <div className="board" data-testid="board">
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
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 84,
    overscan: 6,
  });

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
                  <RunDot run={row.run} />
                  <span className="mono">{row.task.id}</span>
                  <span className="spacer" />
                  <span className="nums">{age(row.ageMinutes)}</span>
                </div>
                <div className="card-title">{row.task.title}</div>
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
