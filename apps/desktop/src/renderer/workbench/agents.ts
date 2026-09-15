import {
  type Question,
  type Run,
  type RunBlockedOn,
  type RunEndReason,
  type RunStatus,
  runLabel,
} from "@loom/core";
import type { PaneView } from "@loom/protocol";

export type Indicator = {
  tone: string;
  icon: string;
  label: string;
  priority: number;
};

type IndicatorDetails = {
  blockedOn?: RunBlockedOn | null;
  endReason?: RunEndReason | null;
  finishedTurn?: boolean;
};

/** The single Workbench mapping from an agent status to its visible indicator. */
export function agentIndicator(
  status: RunStatus,
  details: IndicatorDetails = {},
): Indicator {
  if (status === "ended") {
    if (!details.endReason)
      return { tone: "finished", icon: "●", label: "Ended", priority: 4 };
    if (details.endReason === "submitted")
      return { tone: "finished", icon: "●", label: "Finished", priority: 4 };
    if (details.endReason === "crashed")
      return { tone: "failed", icon: "!", label: "Failed", priority: 1 };
    return {
      tone: "idle",
      icon: "−",
      label: details.endReason === "canceled" ? "Canceled" : "Stopped",
      priority: 5,
    };
  }
  if (status === "failed")
    return { tone: "failed", icon: "!", label: "Failed", priority: 1 };
  if (status === "unknown")
    return {
      tone: "unknown",
      icon: "?",
      label: "Status unavailable",
      priority: 2,
    };
  if (status === "blocked") {
    if (details.blockedOn === "input" || details.blockedOn === "permission")
      return {
        tone: "waiting",
        icon: "●",
        label:
          details.blockedOn === "permission"
            ? "Awaiting permission"
            : "Awaiting response",
        priority: 0,
      };
    return {
      tone: "waiting",
      icon: "Ⅱ",
      label: details.blockedOn === "rate_limit" ? "Rate limited" : "Blocked",
      priority: 2,
    };
  }
  if (status === "working" || status === "starting")
    return {
      tone: "working",
      icon: "◌",
      label: status === "starting" ? "Starting" : "Working",
      priority: 3,
    };
  if (details.finishedTurn)
    return { tone: "finished", icon: "●", label: "Finished turn", priority: 4 };
  return { tone: "idle", icon: "○", label: "Idle", priority: 5 };
}

/** Provider/coordinator facts only. A shell exiting or a quiet terminal is not completion. */
export function agentState(
  run: Run,
  questions: readonly Question[] = [],
): Indicator {
  const awaitingQuestion = questions.some(
    (question) => question.runId === run.id && question.answeredAt === null,
  );
  const status =
    awaitingQuestion && run.status !== "ended" ? "blocked" : run.status;
  return agentIndicator(status, {
    blockedOn:
      status === "blocked" && awaitingQuestion ? "input" : run.blockedOn,
    endReason: run.endReason,
    finishedTurn: run.lastTurn?.outcome === "completed",
  });
}

/** Only live, recorded agent terminals belong here. Task history and headless runs do not. */
export function terminalAgents(
  panes: readonly PaneView[],
  runs: readonly Run[],
  questions: readonly Question[],
  filter = "",
) {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  return panes
    .flatMap((pane) => {
      const run = pane.runId ? byRun.get(pane.runId) : undefined;
      if (
        pane.dead ||
        pane.unavailable ||
        !run ||
        run.status === "ended" ||
        !run.pane ||
        run.pane.hostGeneration !== pane.hostGeneration ||
        run.pane.paneId !== pane.paneId
      )
        return [];
      const name = pane.paneTitle ?? runLabel(run);
      const subtext = `${pane.taskName ?? pane.issueKey ?? "Issue"} · ${run.provider}`;
      if (
        !`${name} ${subtext} ${pane.issueKey ?? ""} ${pane.taskId ?? ""}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase())
      )
        return [];
      return [{ pane, run, name, subtext, state: agentState(run, questions) }];
    })
    .sort(
      (a, b) =>
        a.state.priority - b.state.priority || a.name.localeCompare(b.name),
    );
}
