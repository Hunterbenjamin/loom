import type { Run, Task } from "@loom/core";
import { memo } from "react";
import { agentState } from "../workbench/agents.js";
import type { Indicator } from "../workbench/selectors.js";
import { Status } from "../workbench/status.js";
import {
  ATTENTION_LABELS,
  RUN_STATUS_LABELS,
  shortModelName,
} from "./format.js";

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

/** The same glyph set as the Workbench sidebar: spinner, red, blue, hollow circle. */
export const RunDot = memo(function RunDot({ run }: { run: Run | null }) {
  if (!run) return <span className="dot faint" title="No run" />;
  return (
    <span
      title={`${run.role} · ${run.provider} · ${RUN_STATUS_LABELS[run.status]}`}
    >
      <Status state={agentState(run) as Indicator} />
    </span>
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

  const label = `${run.role} ${shortModelName(run.model)}`;
  const details = `${run.role} · ${run.provider} · ${run.model || "—"}${runs && runs.length > 1 ? ` · ${runs.length} runs` : ""}`;
  return (
    <span className="dim" title={details}>
      {label}
    </span>
  );
});
