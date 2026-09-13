import type { Run } from "@loom/core";
import type { PaneView } from "@loom/protocol";
import { paneIndicator } from "../workbench/selectors.js";

/** Native pane IDs survive renames, but never a pane-host generation change. */
export const paneKey = (pane: Pick<PaneView, "hostGeneration" | "paneId">) =>
  JSON.stringify([pane.hostGeneration, pane.paneId]);

export function createPaneTransitionDetector() {
  let previous = new Map<string, string>();
  return {
    reset() {
      previous.clear();
    },
    observe(
      panes: readonly PaneView[],
      runs: readonly Run[],
      unavailable = false,
    ) {
      const byRun = new Map(runs.map((run) => [run.id, run]));
      const next = new Map<string, string>();
      const transitions: PaneView[] = [];
      for (const pane of panes) {
        // An observation outage is not a transition, nor is recovery a new alert.
        if (unavailable || pane.unavailable) continue;
        const key = paneKey(pane);
        const tone = paneIndicator(
          pane,
          pane.runId ? byRun.get(pane.runId) : undefined,
        ).tone;
        const before = previous.get(key);
        if (
          before !== undefined &&
          before !== tone &&
          (tone === "waiting" || tone === "finished")
        )
          transitions.push(pane);
        next.set(key, tone);
      }
      previous = next;
      return transitions;
    },
  };
}
