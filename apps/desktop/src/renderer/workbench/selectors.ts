import { type Run, runLabel } from "@loom/core";
import type { PaneIdentity, PaneView } from "@loom/protocol";

export const sameTerminal = (a: PaneIdentity, b: PaneIdentity) =>
  a.hostGeneration === b.hostGeneration &&
  a.windowId === b.windowId &&
  a.paneId === b.paneId;

export const terminalName = (pane: PaneView) =>
  pane.role
    ? `${pane.role} ${pane.provider ?? ""}`.trim()
    : pane.windowName?.startsWith("scratch-")
      ? `Terminal ${pane.paneId.slice(1)}`
      : pane.paneTitle ||
        pane.tabTitle ||
        pane.windowName ||
        pane.command ||
        `Terminal ${pane.paneId.slice(1)}`;

const indicators = {
  waiting: { tone: "waiting", icon: "●", label: "Needs you", priority: 0 },
  failed: { tone: "failed", icon: "!", label: "Failed", priority: 1 },
  unknown: {
    tone: "unknown",
    icon: "?",
    label: "Status unavailable",
    priority: 2,
  },
  working: { tone: "working", icon: "◌", label: "Working", priority: 3 },
  finished: { tone: "finished", icon: "●", label: "Finished", priority: 4 },
  idle: { tone: "idle", icon: "○", label: "Idle", priority: 5 },
};
export type Indicator = (typeof indicators)[keyof typeof indicators];

/** Only published provider status and coordinator attention determine the indicator. */
export function paneIndicator(pane: PaneView, run?: Run): Indicator {
  const recorded =
    run?.id === pane.runId &&
    run?.pane &&
    run.pane.hostGeneration === pane.hostGeneration &&
    run.pane.paneId === pane.paneId
      ? run
      : undefined;
  if (pane.attention || pane.status === "blocked")
    return {
      ...indicators.waiting,
      label:
        recorded?.blockedOn === "permission"
          ? "Needs you: permission"
          : pane.status === "blocked"
            ? "Blocked / needs you"
            : "Needs you",
    };
  if (pane.unavailable) return indicators.unknown;
  if (
    pane.status === "failed" ||
    (pane.status === "ended" && recorded?.endReason === "crashed")
  )
    return indicators.failed;
  if (pane.status === "unknown") return indicators.unknown;
  if (pane.status === "working" || pane.status === "starting")
    return {
      ...indicators.working,
      label: pane.status === "starting" ? "Starting" : "Working",
    };
  if (pane.status === "ended")
    return { ...indicators.finished, label: "Ended" };
  if (pane.status === "idle" && recorded?.lastTurn?.outcome === "completed")
    return { ...indicators.finished, label: "Finished turn" };
  if (pane.status === "idle" || (pane.status === null && !pane.runId))
    return indicators.idle;
  return indicators.unknown;
}

export const paneName = (pane: PaneView) =>
  pane.role
    ? [pane.role, pane.provider].filter(Boolean).join(" · ")
    : (pane.agent ?? pane.command ?? "Unknown process");
export const agentName = (pane: PaneView, run?: Run) =>
  pane.paneTitle ?? (run ? runLabel(run) : paneName(pane));
export const spaceKey = (pane: PaneView) =>
  JSON.stringify([pane.hostGeneration, pane.sessionId ?? pane.sessionName]);
export const tabKey = (pane: PaneView) =>
  JSON.stringify([
    pane.hostGeneration,
    pane.sessionId ?? pane.sessionName,
    pane.windowId,
  ]);
const workbenchSessionLabels = new Map([
  ["loom-coordinator", "Coordinator"],
  ["loom-desktop", "Desktop"],
]);
const pinned = (pane: PaneView) =>
  pane.sessionName.startsWith("loom-lead-") ||
  workbenchSessionLabels.has(pane.sessionName);
const rollup = (states: Indicator[]) =>
  states.reduce(
    (worst, state) => (state.priority < worst.priority ? state : worst),
    indicators.idle,
  );
const fuzzyMatch = (text: string, words: string[]) =>
  words.every((word) => {
    let at = -1;
    for (const c of word) {
      at = text.indexOf(c, at + 1);
      if (at < 0) return false;
    }
    return true;
  });

export type TreePane = { pane: PaneView; name: string; indicator: Indicator };
export type TreeTab = {
  key: string;
  name: string;
  windowName: string;
  panes: TreePane[];
  indicator: Indicator;
};
export type TreeSpace = {
  key: string;
  name: string;
  label: string;
  subtext: string | null;
  branch: string | null;
  tabs: TreeTab[];
  indicator: Indicator;
};

/** Native session/window identity defines the tree; names and task labels are display metadata. */
export function spaces(
  panes: readonly PaneView[],
  filter = "",
  runs: readonly Run[] = [],
  includePinned = false,
  /** Panes whose latest finish the human has already looked at: shown idle, not finished. */
  read?: ReadonlySet<string>,
): TreeSpace[] {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const indicatorFor = (pane: PaneView) => {
    const state = paneIndicator(
      pane,
      pane.runId ? byRun.get(pane.runId) : undefined,
    );
    return state.tone === "finished" &&
      read?.has(JSON.stringify([pane.hostGeneration, pane.paneId]))
      ? indicators.idle
      : state;
  };
  const groups = new Map<string, TreeSpace>();
  const tabs = new Map<string, TreeTab>();
  const sorted = [...panes]
    .filter((pane) => includePinned || !pinned(pane))
    .sort(
      (a, b) =>
        a.sessionName.localeCompare(b.sessionName) ||
        a.hostGeneration.localeCompare(b.hostGeneration) ||
        (a.windowIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.windowIndex ?? Number.MAX_SAFE_INTEGER) ||
        (a.windowId ?? "").localeCompare(b.windowId ?? "", undefined, {
          numeric: true,
        }) ||
        a.paneId.localeCompare(b.paneId, undefined, { numeric: true }),
    );
  for (const pane of sorted) {
    const key = spaceKey(pane);
    let space = groups.get(key);
    if (!space) {
      space = {
        key,
        name: pane.sessionName,
        label: pane.spaceTitle ?? pane.taskName ?? pane.sessionName,
        subtext:
          pane.issueKey && pane.taskStage
            ? `${pane.issueKey} · ${pane.taskStage.replaceAll("_", " ")}`
            : null,
        branch: pane.branch,
        tabs: [],
        indicator: indicators.idle,
      };
      groups.set(key, space);
    }
    if (pane.taskName) {
      if (pane.spaceTitle) space.label = pane.spaceTitle;
      else if (space.label === space.name) space.label = pane.taskName;
      space.subtext =
        pane.issueKey && pane.taskStage
          ? `${pane.issueKey} · ${pane.taskStage.replaceAll("_", " ")}`
          : null;
      space.branch = pane.branch;
    }
    const windowKey = tabKey(pane);
    let tab = tabs.get(windowKey);
    if (!tab) {
      const linkedRun = pane.runId ? byRun.get(pane.runId) : undefined;
      tab = {
        key: windowKey,
        name:
          pane.tabTitle ??
          ((linkedRun
            ? runLabel(linkedRun)
            : pane.role
              ? `${pane.role[0]?.toUpperCase()}${pane.role.slice(1)}`
              : pane.windowName) ||
            pane.windowId ||
            "Tab"),
        windowName: pane.windowName || pane.windowId || "Tab",
        panes: [],
        indicator: indicators.idle,
      };
      tabs.set(windowKey, tab);
      space.tabs.push(tab);
    }
    tab.panes.push({
      pane,
      name: agentName(pane, pane.runId ? byRun.get(pane.runId) : undefined),
      indicator: indicatorFor(pane),
    });
  }
  const words = filter.trim().toLowerCase().split(/\s+/);
  return [...groups.values()]
    .map((space) => {
      for (const tab of space.tabs)
        tab.indicator = rollup(tab.panes.map((row) => row.indicator));
      // Filtering hides rows, never a sibling's attention in the parent rollup.
      return {
        ...space,
        indicator: rollup(space.tabs.map((tab) => tab.indicator)),
        tabs: space.tabs
          .map((tab) => ({
            ...tab,
            panes: tab.panes.filter(({ pane, name }) => {
              const fields = [
                space.name,
                space.label,
                space.subtext,
                tab.name,
                tab.windowName,
                pane.taskId,
                pane.taskName,
                pane.issueKey,
                pane.issueKey?.split("-").at(-1),
                pane.spaceTitle,
                pane.tabTitle,
                pane.paneTitle,
                pane.paneId,
                name,
              ].map((value) => String(value ?? "").toLowerCase());
              return words.every((word) =>
                fields.some((field) => fuzzyMatch(field, [word])),
              );
            }),
          }))
          .filter((tab) => tab.panes.length),
      };
    })
    .filter((space) => space.tabs.length);
}

/** Development services are rendered below the scrolling sidebar sections. */
export function workbenchSessions(
  panes: readonly PaneView[],
  runs: readonly Run[] = [],
): TreeSpace[] {
  return spaces(
    panes.filter((pane) => workbenchSessionLabels.has(pane.sessionName)),
    "",
    runs,
    true,
  ).map((space) => ({
    ...space,
    label: workbenchSessionLabels.get(space.name) ?? space.name,
  }));
}

export const attentionPanes = (panes: readonly PaneView[]) =>
  spaces(panes)
    .flatMap((space) =>
      space.tabs.flatMap((tab) => tab.panes.map(({ pane }) => pane)),
    )
    .filter((pane) => pane.attention && !pane.dead);
