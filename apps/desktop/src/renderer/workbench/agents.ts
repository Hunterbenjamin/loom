import { type Question, type Run, runLabel } from "@loom/core";
import type { PaneView } from "@loom/protocol";

/** Provider/coordinator facts only. A shell exiting or a quiet terminal is not completion. */
export function agentState(run: Run, questions: readonly Question[] = []) {
  if (run.status === "ended") {
    if (run.endReason === "submitted")
      return { tone: "finished", icon: "●", label: "Finished", priority: 4 };
    if (run.endReason === "crashed")
      return { tone: "failed", icon: "!", label: "Failed", priority: 1 };
    return {
      tone: "idle",
      icon: "−",
      label: run.endReason === "canceled" ? "Canceled" : "Stopped",
      priority: 5,
    };
  }
  if (
    questions.some((q) => q.runId === run.id && q.answeredAt === null) ||
    (run.status === "blocked" &&
      (run.blockedOn === "input" || run.blockedOn === "permission"))
  )
    return {
      tone: "waiting",
      icon: "●",
      label:
        run.blockedOn === "permission"
          ? "Awaiting permission"
          : "Awaiting response",
      priority: 0,
    };
  if (run.status === "failed")
    return { tone: "failed", icon: "!", label: "Failed", priority: 1 };
  if (run.status === "unknown")
    return {
      tone: "unknown",
      icon: "?",
      label: "Status unavailable",
      priority: 1,
    };
  if (run.status === "blocked")
    return {
      tone: "waiting",
      icon: "Ⅱ",
      label: run.blockedOn === "rate_limit" ? "Rate limited" : "Blocked",
      priority: 2,
    };
  if (run.status === "working" || run.status === "starting")
    return {
      tone: "working",
      icon: "◌",
      label: run.status === "starting" ? "Starting" : "Working",
      priority: 3,
    };
  if (run.lastTurn?.outcome === "completed")
    return { tone: "finished", icon: "●", label: "Finished turn", priority: 4 };
  return { tone: "idle", icon: "○", label: "Idle", priority: 4 };
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
      const name = runLabel(run);
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
