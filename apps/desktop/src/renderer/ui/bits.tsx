import type { Run, Stage, Task } from "@loom/core";
import type { TaskInbox } from "@loom/protocol";
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
export const RunDot = memo(function RunDot({
  run,
  stage,
  read = false,
}: {
  run: Run | null;
  /** A Done or Canceled issue needs nothing more, so it is always grey. */
  stage?: Stage;
  /** Whether the human has seen this run's finished turn; blue means unread. */
  read?: boolean;
}) {
  if (!run) return <span className="dot faint" title="No run" />;
  return (
    <span
      title={`${run.role} · ${run.provider} · ${RUN_STATUS_LABELS[run.status]}`}
    >
      <Status state={runDotState(run, stage, read)} />
    </span>
  );
});

function runDotState(run: Run, stage: Stage | undefined, read: boolean) {
  if (stage === "done" || stage === "canceled")
    return {
      tone: "idle",
      icon: "○",
      label: stage === "done" ? "Done" : "Canceled",
      priority: 5,
    } satisfies Indicator;
  const state = agentState(run) as Indicator;
  return state.tone === "finished" && read
    ? { ...state, tone: "idle", icon: "○" }
    : state;
}

export function CiDot({ ci }: { ci: TaskInbox["ci"] | null }) {
  if (!ci || ci.conclusion === null || ci.conclusion === "pending")
    return (
      <Status
        state={
          {
            tone: "working",
            icon: "◌",
            label: "CI running",
            priority: 3,
          } as Indicator
        }
      />
    );
  if (ci.conclusion === "failure")
    return (
      <Status
        state={
          {
            tone: "failed",
            icon: "!",
            label: "CI failed",
            priority: 1,
          } as Indicator
        }
      />
    );
  return (
    <Status
      state={
        {
          tone: "finished",
          icon: "●",
          label: "CI passed",
          priority: 4,
        } as Indicator
      }
    />
  );
}

export function CiChip({
  ci,
  elapsed,
}: {
  ci: TaskInbox["ci"] | null;
  elapsed: string;
}) {
  const check = ci?.checks.find(
    (item) => item.status !== "completed" || item.conclusion !== "success",
  );
  const state = check
    ? check.status === "in_progress"
      ? "running"
      : check.status === "queued"
        ? "queued"
        : (check.conclusion ?? "completed")
    : "waiting for checks";
  return (
    <span className="chip" title="CI status">
      {check ? `${check.name} · ${state}` : state} · {elapsed}
    </span>
  );
}

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
