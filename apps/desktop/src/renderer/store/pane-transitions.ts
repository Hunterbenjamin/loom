import type { Run } from "@loom/core";
import type { PaneIdentity, PaneView } from "@loom/protocol";
import { paneIndicator } from "../workbench/selectors.js";
import type { State, StoreContext } from "./store.js";

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

export function paneActivity(ctx: StoreContext) {
  const detector = createPaneTransitionDetector();
  const listeners = new Set<(pane: PaneView) => void>();
  let paneFocus: (() => PaneIdentity | "main" | undefined) | undefined;

  return {
    resetPaneTransitions() {
      detector.reset();
    },
    applyPaneTransitions(previous: State) {
      let state = ctx.get();
      const transitions =
        previous.panes !== state.panes ||
        previous.snapshot.runs !== state.snapshot.runs ||
        previous.panesUnavailable !== state.panesUnavailable
          ? detector.observe(
              state.panes,
              state.snapshot.runs,
              state.panesUnavailable,
            )
          : [];
      if (transitions.length) {
        const byRun = new Map(state.snapshot.runs.map((run) => [run.id, run]));
        const read = new Set(state.readFinished);
        for (const pane of transitions)
          if (
            paneIndicator(pane, pane.runId ? byRun.get(pane.runId) : undefined)
              .tone === "finished"
          )
            read.delete(paneKey(pane));
        if (read.size !== state.readFinished.size) {
          state = { ...state, readFinished: read };
          ctx.set(state);
        }
      }

      let leadTransition: PaneView | undefined;
      if (
        previous.lead.status === "working" &&
        (state.lead.status === "idle" || state.lead.status === "waiting")
      ) {
        if (state.lead.status === "idle") {
          state = { ...state, mainFinished: true };
          ctx.set(state);
        }
        leadTransition = state.panes.find(
          (pane) =>
            pane.sessionName === `loom-lead-${state.ui.repo}` && !pane.dead,
        );
      }
      return () => {
        for (const pane of transitions)
          for (const listener of listeners) listener(pane);
        if (leadTransition)
          for (const listener of listeners) listener(leadTransition);
      };
    },
    subscribePaneTransitions(listener: (pane: PaneView) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerPaneFocus(reader: NonNullable<typeof paneFocus>) {
      paneFocus = reader;
      return () => {
        if (paneFocus === reader) paneFocus = undefined;
      };
    },
    focusedPane() {
      return paneFocus?.();
    },
    markMainRead() {
      const state = ctx.get();
      if (!state.mainFinished) return;
      ctx.set({ ...state, mainFinished: false });
      ctx.emit();
    },
    markPanesRead(
      panes: readonly Pick<PaneView, "hostGeneration" | "paneId">[],
    ) {
      const state = ctx.get();
      const keys = panes
        .map(paneKey)
        .filter((key) => !state.readFinished.has(key));
      if (!keys.length) return;
      ctx.set({
        ...state,
        readFinished: new Set([...state.readFinished, ...keys]),
      });
      ctx.emit();
    },
  };
}
