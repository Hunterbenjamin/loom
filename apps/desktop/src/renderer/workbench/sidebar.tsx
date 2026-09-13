import type { PaneView } from "@loom/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paneKey } from "../store/pane-transitions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { RowMenu } from "./row-menu.js";
import { type Indicator, spaceKey, spaces, tabKey } from "./selectors.js";

function Status({ state }: { state: Indicator }) {
  return (
    <span
      className={`wb-status ${state.tone}`}
      role="img"
      aria-label={state.label}
    >
      {state.icon}
    </span>
  );
}

export function Sidebar({
  filter,
  setFilter,
  choose,
  newTerminal,
  openPinned,
  openGroup,
  hidePanels,
  hasPanels,
  copyAttach,
}: {
  filter: string;
  setFilter: (value: string) => void;
  choose: (pane: PaneView, newTab?: boolean) => void;
  openGroup: (panes: PaneView[], name: string) => void;
  hidePanels: (panes: PaneView[]) => void;
  hasPanels: (panes: PaneView[]) => boolean;
  copyAttach: (pane: PaneView) => void;
  newTerminal: () => void;
  openPinned: (target: "main" | "operator") => void;
}) {
  const store = useStoreApi();
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    const animations = new Set<Animation>();
    const stop = store.subscribePaneTransitions((pane) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const pinned =
        pane.sessionName === `loom-lead-${store.getState().ui.repo}` ||
        ["loom-lead", "loom-main"].includes(pane.sessionName)
          ? "main"
          : pane.sessionName === "loom-operator"
            ? "operator"
            : null;
      const row = [
        ...(sidebar.current?.querySelectorAll<HTMLElement>(
          "[data-pane-key], [data-pinned]",
        ) ?? []),
      ].find((element) =>
        pinned
          ? element.dataset.pinned === pinned
          : element.dataset.paneKey === paneKey(pane),
      );
      if (!row) return;
      const animation = row.animate(
        [
          {
            backgroundColor:
              getComputedStyle(row).getPropertyValue("--accent-dim").trim() ||
              "transparent",
          },
          { backgroundColor: "transparent" },
        ],
        { duration: 600, iterations: 1 },
      );
      animations.add(animation);
      void animation.finished.then(
        () => animations.delete(animation),
        () => animations.delete(animation),
      );
    });
    return () => {
      stop();
      for (const animation of animations) animation.cancel();
    };
  }, [store]);
  const panes = useStore((s) => s.panes);
  const unavailable = useStore((s) => s.panesUnavailable);
  const runs = useStore((s) => s.snapshot.runs);
  const tree = useMemo(
    () => spaces(panes, filter, runs),
    [panes, filter, runs],
  );
  const lead = useStore((s) => s.lead);
  const repo = useStore((s) => s.ui.repo);
  const operator = useStore((s) => s.operator);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const expanded = (key: string) => !!filter.trim() || !collapsed.has(key);
  const toggle = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [menu, setMenu] = useState<{
    kind: "space" | "tab" | "pane";
    key: string;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  const dismiss = useCallback(() => setMenu(null), []);
  // Resolve against the full inventory, never the filtered descendants or a stale row object.
  const rowPanes = (kind: "space" | "tab" | "pane", key: string) =>
    panes
      .filter(
        (pane) =>
          (kind === "space"
            ? spaceKey(pane)
            : kind === "tab"
              ? tabKey(pane)
              : paneKey(pane)) === key,
      )
      .sort(
        (a, b) =>
          (a.windowId ?? "").localeCompare(b.windowId ?? "", undefined, {
            numeric: true,
          }) || a.paneId.localeCompare(b.paneId, undefined, { numeric: true }),
      );
  const menuRows = menu ? rowPanes(menu.kind, menu.key) : [];
  const liveRows = menuRows.filter(
    (pane) => !unavailable && !pane.unavailable && !pane.dead,
  );
  const menuName =
    menu?.kind === "space" ? menuRows[0]?.sessionName : menuRows[0]?.windowName;
  const rowMenu = (kind: "space" | "tab" | "pane", key: string) => ({
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setMenu({
        kind,
        key,
        x: event.clientX,
        y: event.clientY,
        trigger:
          (event.target as HTMLElement).closest("button") ??
          event.currentTarget,
      });
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      )
        return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({
        kind,
        key,
        x: rect.left,
        y: rect.bottom,
        trigger:
          (event.target as HTMLElement).closest("button") ??
          event.currentTarget,
      });
    },
  });
  useEffect(() => {
    window.loomHost.interactive();
  }, []);
  return (
    <aside
      ref={sidebar}
      className="wb-sidebar"
      aria-label="Spaces and terminals"
    >
      <input
        id="agent-filter"
        aria-label="Find space, tab or pane"
        placeholder="Find space, tab or pane…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <section className="wb-terminals" aria-label="Terminal tree">
        <div className="wb-section-heading">
          <h2>Spaces</h2>
          <button type="button" aria-label="New terminal" onClick={newTerminal}>
            ＋
          </button>
        </div>
        {unavailable && (
          <p role="status">
            Terminal host unavailable. Showing last known terminals.
          </p>
        )}
        <div className="wb-terminal-list">
          {tree.map((space) => (
            <section key={space.key} aria-label={space.label}>
              <button
                type="button"
                className="wb-tree-row wb-space"
                aria-expanded={expanded(space.key)}
                onClick={() => toggle(space.key)}
                {...rowMenu("space", space.key)}
                title={space.name}
              >
                <span aria-hidden="true">
                  {expanded(space.key) ? "▾" : "▸"}
                </span>
                <Status state={space.indicator} />
                <span className="wb-tree-name">{space.label}</span>
                <small
                  className="wb-space-branch"
                  title={space.branch ?? "Branch unavailable"}
                >
                  {space.branch ?? "—"}
                </small>
              </button>
              {expanded(space.key) &&
                space.tabs.map((tab) => (
                  <section
                    className="wb-tree-tab"
                    key={tab.key}
                    aria-label={tab.name}
                  >
                    <div className="wb-tab-row" {...rowMenu("tab", tab.key)}>
                      <button
                        type="button"
                        className="wb-disclosure"
                        aria-label={`Toggle ${tab.name} panes`}
                        aria-expanded={expanded(tab.key)}
                        onClick={() => toggle(tab.key)}
                      >
                        {expanded(tab.key) ? "▾" : "▸"}
                      </button>
                      <button
                        type="button"
                        className="wb-tree-row"
                        aria-label={`Open tab ${tab.name}`}
                        disabled={
                          !rowPanes("tab", tab.key).some(
                            (pane) =>
                              !unavailable && !pane.unavailable && !pane.dead,
                          )
                        }
                        onClick={() =>
                          openGroup(rowPanes("tab", tab.key), tab.name)
                        }
                      >
                        <Status state={tab.indicator} />
                        <span className="wb-tree-name">{tab.name}</span>
                      </button>
                    </div>
                    {expanded(tab.key) &&
                      tab.panes.map(({ pane, name, indicator }) => (
                        <button
                          type="button"
                          key={pane.id}
                          data-pane-key={paneKey(pane)}
                          className={`wb-tree-row wb-tree-pane ${pane.dead ? "dead" : ""}`}
                          aria-label={`Open ${tab.name} ${name} ${pane.paneId}`}
                          disabled={
                            unavailable || pane.unavailable || pane.dead
                          }
                          {...rowMenu("pane", paneKey(pane))}
                          onClick={() => choose(pane)}
                          onKeyDown={(e) => {
                            rowMenu("pane", paneKey(pane)).onKeyDown(e);
                            if (e.key === "Enter") {
                              e.preventDefault();
                              choose(pane, true);
                            }
                          }}
                          title={`${pane.startCwd}\n${pane.command}${pane.dead ? "\nExited" : ""}`}
                        >
                          <Status state={indicator} />
                          <span className="wb-tree-name">{name}</span>
                          {(pane.runId || pane.status || pane.attention) && (
                            <small
                              className={`wb-state-label ${indicator.tone}`}
                            >
                              {indicator.label}
                            </small>
                          )}
                        </button>
                      ))}
                  </section>
                ))}
            </section>
          ))}
          {!tree.length && (
            <p className="wb-muted">
              {filter ? "No matching terminals" : "No terminals"}
            </p>
          )}
        </div>
      </section>
      {menu && (
        <RowMenu
          {...menu}
          dismiss={dismiss}
          actions={[
            {
              label: "Open",
              disabled: menu.kind !== "space" && !liveRows.length,
              run: () => {
                if (menu.kind === "space") toggle(menu.key);
                else if (menu.kind === "pane" && liveRows[0])
                  choose(liveRows[0]);
                else openGroup(menuRows, menuName ?? "Tab");
              },
            },
            {
              label: "Open in new tab",
              disabled: !liveRows.length,
              run: () => {
                if (menu.kind === "pane" && liveRows[0])
                  choose(liveRows[0], true);
                else openGroup(menuRows, menuName ?? "Tab");
              },
            },
            {
              label: "Rename",
              disabled: true,
              reason: "Native rename is provided by Workbench v2 slice 3",
              run: () => {},
            },
            {
              label: "Copy attach command",
              disabled: !liveRows.length,
              reason: "Attach to the first live pane in this row",
              run: () => {
                if (liveRows[0]) copyAttach(liveRows[0]);
              },
            },
            {
              label: "Close panel",
              disabled: !hasPanels(menuRows),
              reason:
                "Hide this row’s viewers in the current tab; processes keep running",
              run: () => hidePanels(menuRows),
            },
          ]}
        />
      )}
      <section className="wb-pinned" aria-label="Pinned terminals">
        <button
          type="button"
          className="wb-tree-pane"
          disabled={!repo}
          data-pinned="main"
          onClick={() => openPinned("main")}
          title="Open Main terminal"
        >
          <span aria-hidden="true">⌁</span>
          <span>Main</span>
          <small>{lead.status}</small>
        </button>
        <button
          type="button"
          className="wb-tree-pane"
          data-pinned="operator"
          onClick={() => openPinned("operator")}
          title="Open Operator terminal"
        >
          <span aria-hidden="true">⌁</span>
          <span>Operator</span>
          <small>{operator?.status ?? "Connecting"}</small>
        </button>
      </section>
    </aside>
  );
}
