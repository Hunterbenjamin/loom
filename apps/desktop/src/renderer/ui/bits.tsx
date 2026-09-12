import type { Run, Task } from "@loom/core";
import { ATTENTION_LABELS, RUN_STATUS_LABELS } from "./format.js";

export function AttentionChips({ task }: { task: Task }) {
  if (task.attention.reasons.length === 0) return null;
  return (
    <>
      {task.attention.reasons.map((reason) => (
        <span
          key={reason}
          className={`chip ${reason === "failed" || reason === "blocked" ? "danger" : "attention"}`}
        >
          {ATTENTION_LABELS[reason]}
        </span>
      ))}
    </>
  );
}

const DOT: Partial<Record<Run["status"], string>> = {
  working: "working",
  blocked: "blocked",
  failed: "failed",
  unknown: "unknown",
};

export function RunDot({ run }: { run: Run | null }) {
  if (!run) return <span className="dot" title="No run" />;
  return (
    <span
      className={`dot ${DOT[run.status] ?? ""}`}
      title={`${run.role} · ${run.provider} · ${RUN_STATUS_LABELS[run.status]}`}
    />
  );
}

export function ProviderLabel({
  run,
  blank,
}: {
  run: Run | null;
  blank?: boolean;
}) {
  if (!run) return blank ? null : <span className="faint">—</span>;
  return (
    <span className="dim">
      {run.provider === "codex" ? "Codex" : "Claude"}{" "}
      <span className="faint">{run.role[0]}</span>
    </span>
  );
}
