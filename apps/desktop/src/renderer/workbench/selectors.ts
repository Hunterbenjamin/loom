import type { PaneIdentity, PaneView } from "@loom/protocol";

export const sameTerminal = (a: PaneIdentity, b: PaneIdentity) =>
  a.hostGeneration === b.hostGeneration &&
  a.sessionName === b.sessionName &&
  a.windowId === b.windowId &&
  a.paneId === b.paneId;

export const terminalName = (pane: PaneView) =>
  pane.role
    ? `${pane.role} ${pane.provider ?? ""}`.trim()
    : pane.windowName?.startsWith("scratch-")
      ? `Terminal ${pane.paneId.slice(1)}`
      : pane.windowName ||
        pane.title ||
        pane.command ||
        `Terminal ${pane.paneId.slice(1)}`;
export function spaces(panes: readonly PaneView[], filter = "") {
  const sorted = [...panes].sort(
    (a, b) =>
      a.sessionName.localeCompare(b.sessionName) ||
      (a.windowId ?? "").localeCompare(b.windowId ?? "", undefined, {
        numeric: true,
      }) ||
      a.paneId.localeCompare(b.paneId, undefined, { numeric: true }),
  );
  const groups = new Map<
    string,
    { name: string; label: string; panes: PaneView[] }
  >();
  for (const p of sorted) {
    const key = JSON.stringify([p.hostGeneration, p.sessionName]);
    let group = groups.get(key);
    if (!group) {
      group = {
        name: p.sessionName,
        label: p.taskLabel ?? p.sessionName,
        panes: [],
      };
      groups.set(key, group);
    }
    if (p.taskLabel) group.label = p.taskLabel;
    group.panes.push(p);
  }
  const words = filter.toLowerCase().trim().split(/\s+/);
  return [...groups.values()]
    .map((g) => ({
      ...g,
      panes: g.panes.filter((p) => {
        const text = [
          g.label,
          g.name,
          p.taskId,
          p.role,
          p.provider,
          p.title,
          p.windowName,
          p.paneId,
          p.command,
        ]
          .join(" ")
          .toLowerCase();
        return words.every((word) => {
          let at = -1;
          for (const c of word) {
            at = text.indexOf(c, at + 1);
            if (at < 0) return false;
          }
          return true;
        });
      }),
    }))
    .filter((g) => g.panes.length);
}
export const attentionPanes = (panes: readonly PaneView[]) =>
  spaces(panes)
    .flatMap((g) => g.panes)
    .filter((p) => p.attention);

/** Flat terminal inventory, independent of issue titles and issue grouping. */
export function terminalList(panes: readonly PaneView[], filter = "") {
  const query = filter.trim().toLowerCase();
  return panes
    .filter(
      (pane) =>
        !pane.dead &&
        !["loom-lead", "loom-main", "loom-operator"].includes(pane.sessionName),
    )
    .map((pane) => ({
      pane,
      name: terminalName(pane),
    }))
    .filter(({ name }) => name.toLowerCase().includes(query))
    .sort((a, b) =>
      a.pane.paneId.localeCompare(b.pane.paneId, undefined, { numeric: true }),
    );
}
