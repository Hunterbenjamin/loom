import type { AckResult, PaneIdentity, PaneView } from "@loom/protocol";
import { sameTerminal, spaces } from "./selectors.js";

export type Panel = {
  id: string;
  target?: PaneIdentity;
  name?: string;
};

export type Tab = {
  id: string;
  name: string;
  panels: Panel[];
  layout?: string;
};

export const newPanel = (target?: PaneIdentity): Panel => ({
  id: crypto.randomUUID(),
  target,
});

export const identity = (pane: PaneIdentity): PaneIdentity => ({
  hostGeneration: pane.hostGeneration,
  sessionName: pane.sessionName,
  windowId: pane.windowId,
  paneId: pane.paneId,
});

/** The terminal a create command made: new scratch terminals ack either shape. */
export const createdTerminal = (
  outcome: AckResult,
): PaneIdentity | undefined =>
  outcome.kind === "scratch_created"
    ? outcome.pane
    : outcome.kind === "attach_session" &&
        "identity" in outcome.target &&
        outcome.target.identity === "pane"
      ? outcome.target.target
      : undefined;

export const spaceTabs = (rows: PaneView[], previous: Tab[] = []): Tab[] =>
  (spaces(rows, "", [], true)[0]?.tabs ?? []).map((tab) => ({
    id: tab.key,
    name: tab.name,
    layout: tab.panes[0]?.pane.windowLayout,
    panels: tab.panes
      .filter(
        ({ pane }) =>
          !pane.dead &&
          (!pane.unavailable ||
            previous.some((candidate) =>
              candidate.panels.some(
                (panel) => panel.target && sameTerminal(panel.target, pane),
              ),
            )),
      )
      .map(
        ({ pane }) =>
          previous
            .flatMap((candidate) => candidate.panels)
            .find(
              (panel) => panel.target && sameTerminal(panel.target, pane),
            ) ?? newPanel(identity(pane)),
      ),
  }));
