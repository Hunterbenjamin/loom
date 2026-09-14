import { displayName } from "@loom/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useRef, useState } from "react";
import { inboxRows, REASON_LABELS, reasonTab } from "../store/inbox.js";
import { useStore, useStoreApi } from "../store/react.js";
import { issueKeyFor } from "../store/selectors.js";
import { age } from "./format.js";

/** A clock confined to inbox rows: waiting-time updates do not invalidate the task list. */
export const InboxView = memo(function InboxView() {
  const store = useStoreApi();
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
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 94,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  useEffect(() => {
    list.scrollToIndex(cursor, { align: "auto" });
  }, [cursor, list]);
  return (
    <section className="inbox" ref={parent} aria-label="Needs you inbox">
      {rows.length === 0 ? (
        <div className="pad faint">
          {connection === "connected" || connection === "fixtures"
            ? "Nothing needs you right now."
            : "Waiting for the coordinator. Issues will appear after connection."}
        </div>
      ) : null}
      <div style={{ height: list.getTotalSize(), position: "relative" }}>
        {list.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const run = row.runs[0] ?? null;
          return (
            <button
              type="button"
              key={row.key}
              className={`inbox-row ${item.index === cursor ? "selected" : ""}`}
              style={{
                position: "absolute",
                top: item.start,
                height: item.size,
                width: "100%",
              }}
              data-reason={row.reason}
              onClick={() => {
                store.setCursor(item.index);
                store.openAttention(
                  row.task.id,
                  row.reason,
                  reasonTab(row.reason, run),
                  run?.id ?? null,
                );
              }}
            >
              <span>
                <strong>
                  {row.forHuman ? "For human · " : ""}
                  {REASON_LABELS[row.reason]}
                </strong>
                <span className="faint">
                  {" "}
                  ·{" "}
                  {row.since
                    ? `${age(Math.max(0, Math.floor((now - Date.parse(row.since)) / 60_000)))} waiting`
                    : "Waiting time unavailable"}
                </span>
              </span>
              <span>
                <span title={row.task.title}>{displayName(row.task)}</span>{" "}
                <span className="faint mono">
                  {issueKeyFor(row.task, repos)}
                </span>
              </span>
              <span className="faint">
                {row.runs
                  .map((r) => `${r.role} · ${r.provider} · ${r.mode}`)
                  .join(" / ")}
                {row.reason === "needs_approval"
                  ? `Reviewed SHA: ${row.reviewedHead ?? "not available"}`
                  : ""}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
});
