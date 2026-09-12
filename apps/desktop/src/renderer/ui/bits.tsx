import type { Run, Task } from "@loom/core";
import { memo } from "react";
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

// Map run status to dot glyph: working/starting (animated), blocked (attention), idle/ended (stage), failed/unknown (status)
// Priority order: working > blocked > idle > ended > unknown
const DOT: Partial<Record<Run["status"], string>> = {
  starting: "dot-animated", // Animated circular progress indicator
  working: "dot-animated", // Animated circular progress indicator
  blocked: "dot-attention", // Static attention glyph for blocked/waiting
  idle: "dot-stage", // Stage glyph for idle
  failed: "dot-failed", // Failed glyph
  ended: "dot-stage", // Stage glyph for terminal status
  unknown: "dot-unknown", // Unknown glyph
};

export const RunDot = memo(function RunDot({ run }: { run: Run | null }) {
  if (!run) return <span className="dot faint" title="No run" />;
  const glyph = DOT[run.status] ?? "dot-unknown";
  return (
    <span
      className={`dot ${glyph}`}
      title={`${run.role} · ${run.provider} · ${RUN_STATUS_LABELS[run.status]}`}
    />
  );
});

export const ProviderLabel = memo(function ProviderLabel({
  run,
  runs,
  blank,
}: {
  run: Run | null;
  runs?: Run[];
  blank?: boolean;
}) {
  if (!run) return blank ? null : <span className="faint">—</span>;

  // Show role · provider · model for a single run
  const label = `${run.role[0]} · ${run.provider === "codex" ? "c" : "C"} · ${run.model || "—"}`;

  // If multiple runs, show the most recent one's details plus a count
  if (runs && runs.length > 1) {
    return (
      <span className="dim" title={`${runs.length} run(s) for this task`}>
        {label} <span className="faint">+{runs.length - 1}</span>
      </span>
    );
  }

  return <span className="dim">{label}</span>;
});
