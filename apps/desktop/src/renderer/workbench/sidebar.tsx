import type { PaneIdentity, PaneView } from "@loom/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paneKey } from "../store/pane-transitions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { RenameRow } from "./rename-row.js";
import { RowMenu } from "./row-menu.js";
import { type Indicator, spaceKey, spaces, tabKey } from "./selectors.js";
import { Status } from "./status.js";

function pinnedState(status: string): Indicator {
  const tone =
    status === "waiting"
      ? "waiting"
      : status === "error"
        ? "failed"
        : status === "stopped"
          ? "idle"
          : status;
  const icon =
    tone === "working"
      ? "◌"
      : tone === "waiting"
        ? "●"
        : tone === "idle"
          ? "○"
          : tone === "failed"
            ? "!"
            : "?";
  return {
    tone,
    icon,
    label: status === "waiting" ? "Needs you" : status,
    priority: 0,
  };
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
  selected,
  selectedSpace,
  selectedTab,
  collapsed: sidebarCollapsed = false,
  toggleSidebar,
  showMenu,
}: {
  selectedSpace?: string;
  selectedTab?: string;
  selected?: PaneIdentity | "main";
  collapsed?: boolean;
  toggleSidebar?: () => void;
  showMenu?: () => void;
  filter: string;
  setFilter: (value: string) => void;
  choose: (pane: PaneView, newTab?: boolean) => void;
  openGroup: (panes: PaneView[], name: string) => void;
  hidePanels: (panes: PaneView[]) => void;
  hasPanels: (panes: PaneView[]) => boolean;
  copyAttach: (pane: PaneView) => void;
  newTerminal: () => void;
  openPinned: (target: "main") => void;
}) {
  const store = useStoreApi();
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    const animations = new Set<Animation>();
    const stop = store.subscribePaneTransitions((pane) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const row = [
        ...(sidebar.current?.querySelectorAll<HTMLElement>(
          "[data-pane-key], [data-pinned]",
        ) ?? []),
      ].filter((element) => element.dataset.paneKey === paneKey(pane));
      for (const element of row) {
        const animation = element.animate(
          [
            {
              backgroundColor:
                getComputedStyle(element)
                  .getPropertyValue("--accent-dim")
                  .trim() || "transparent",
            },
            { backgroundColor: getComputedStyle(element).backgroundColor },
          ],
          { duration: 600, iterations: 1 },
        );
        animations.add(animation);
        void animation.finished.then(
          () => animations.delete(animation),
          () => animations.delete(animation),
        );
      }
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
  const [grouped, setGrouped] = useState(true);
  const agents = tree.flatMap((space) =>
    space.tabs.flatMap((tab) =>
      tab.panes
        .filter(({ pane }) => pane.provider || pane.runId)
        .map((row) => ({ ...row, space, tab })),
    ),
  );
  if (!grouped)
    agents.sort(
      (a, b) =>
        a.indicator.priority - b.indicator.priority ||
        a.pane.id.localeCompare(b.pane.id),
    );
  const selectedPane =
    typeof selected === "object"
      ? panes.find((pane) => paneKey(pane) === paneKey(selected))
      : undefined;
  const isSelected = (pane: PaneView) =>
    !!selectedPane && paneKey(pane) === paneKey(selectedPane);
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
          (a.windowIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.windowIndex ?? Number.MAX_SAFE_INTEGER) ||
          (a.windowId ?? "").localeCompare(b.windowId ?? "", undefined, {
            numeric: true,
          }) ||
          a.paneId.localeCompare(b.paneId, undefined, { numeric: true }),
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
      className={`wb-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}
      aria-label="Spaces and terminals"
    >
      {!sidebarCollapsed && (
        <>
          <section className="wb-terminals" aria-label="Terminal tree">
            <div className="wb-section-heading">
              <h2>spaces</h2>
            </div>
            <input
              id="agent-filter"
              aria-label="Find space, tab or agent"
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {unavailable && (
              <p role="status">
                Terminal host unavailable. Showing last known terminals.
              </p>
            )}
            <div className="wb-terminal-list">
              {tree.map((space) => (
                <section key={space.key} aria-label={space.label}>
                  <div
                    className="wb-space-row"
                    {...rowMenu("space", space.key)}
                  >
                    <button
                      type="button"
                      className="wb-disclosure"
                      aria-label={`Toggle ${space.label} tabs`}
                      aria-expanded={expanded(space.key)}
                      onClick={() => toggle(space.key)}
                    >
                      {expanded(space.key) ? "⌄" : "›"}
                    </button>
                    <RenameRow
                      kind="space"
                      pane={space.tabs[0]?.panes[0]?.pane}
                      name={space.name}
                      className="wb-space"
                      current={
                        selectedSpace === space.key ||
                        (!!selectedPane && spaceKey(selectedPane) === space.key)
                      }
                      ariaLabel={`Open space ${space.label}`}
                      toggle={() =>
                        openGroup(rowPanes("space", space.key), space.name)
                      }
                    >
                      <Status state={space.indicator} />
                      <span className="wb-row-copy">
                        <span className="wb-tree-name">{space.label}</span>
                        <small
                          className="wb-space-branch"
                          title={space.branch ?? "Branch unavailable"}
                        >
                          {space.branch ?? "—"}
                        </small>
                      </span>
                    </RenameRow>
                  </div>
                  {expanded(space.key) &&
                    space.tabs.map((tab) => (
                      <section
                        className="wb-tree-tab"
                        key={tab.key}
                        aria-label={tab.name}
                      >
                        <div
                          className="wb-tab-row"
                          aria-current={
                            selectedTab === tab.key ||
                            (selectedPane && tabKey(selectedPane) === tab.key)
                              ? "true"
                              : undefined
                          }
                          {...rowMenu("tab", tab.key)}
                        >
                          <RenameRow
                            kind="tab"
                            pane={tab.panes[0]?.pane}
                            name={tab.name}
                            ariaLabel={`Open tab ${tab.name}`}
                            disabled={
                              !rowPanes("tab", tab.key).some(
                                (pane) =>
                                  !unavailable &&
                                  !pane.unavailable &&
                                  !pane.dead,
                              )
                            }
                            toggle={() =>
                              openGroup(rowPanes("tab", tab.key), tab.name)
                            }
                          >
                            <Status state={tab.indicator} />
                            <span className="wb-tree-name">{tab.name}</span>
                          </RenameRow>
                        </div>
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
            <footer className="wb-spaces-footer">
              <button
                type="button"
                aria-label="New terminal"
                onClick={newTerminal}
              >
                new
              </button>
              <button
                type="button"
                aria-label="Workbench menu"
                onClick={showMenu}
              >
                menu
              </button>
            </footer>
          </section>
          <section className="wb-agents" aria-label="Agents">
            <div className="wb-section-heading">
              <h2>agents</h2>
              <button
                type="button"
                aria-label="Group agents by space"
                aria-pressed={grouped}
                onClick={() => setGrouped((value) => !value)}
              >
                {grouped ? "grouped" : "ungrouped"}
              </button>
            </div>
            <section className="wb-pinned" aria-label="Pinned terminals">
              <div className="wb-pinned-agent">
                <button
                  type="button"
                  className="wb-tree-row wb-agent-row"
                  disabled={!repo}
                  data-pinned="main"
                  aria-current={selected === "main" ? "true" : undefined}
                  onClick={() => openPinned("main")}
                  title="Open Main terminal"
                >
                  <Status state={pinnedState(lead.status)} />
                  <span className="wb-row-copy">
                    <strong>Main</strong>
                    <small>{lead.status}</small>
                  </span>
                </button>
              </div>
            </section>
            <div className="wb-agent-list">
              {agents.map(({ pane, indicator, space, tab }) => (
                <button
                  type="button"
                  key={pane.id}
                  data-pane-key={paneKey(pane)}
                  className={`wb-tree-row wb-agent-row ${pane.dead ? "dead" : ""}`}
                  aria-label={`Open agent ${space.label} ${tab.name} ${pane.paneId}`}
                  aria-current={isSelected(pane) ? "true" : undefined}
                  disabled={unavailable || pane.unavailable || pane.dead}
                  {...rowMenu("pane", paneKey(pane))}
                  onClick={() => choose(pane)}
                  onKeyDown={(e) => {
                    rowMenu("pane", paneKey(pane)).onKeyDown(e);
                    if (e.key === "Enter") {
                      e.preventDefault();
                      choose(pane, true);
                    }
                  }}
                  title={`${space.name} · ${tab.name} · ${pane.paneId}\n${indicator.label}${pane.dead ? "\nExited" : ""}`}
                >
                  <Status state={indicator} />
                  <span className="wb-row-copy">
                    <span className="wb-tree-name">
                      <strong>{space.label}</strong>
                      <span className="wb-agent-tab"> · {tab.name}</span>
                    </span>
                    <small>{pane.provider ?? "—"}</small>
                  </span>
                </button>
              ))}
              {!agents.length && (
                <p className="wb-muted">
                  {filter ? "No matching agents" : "No agents"}
                </p>
              )}
            </div>
          </section>
        </>
      )}
      <footer className="wb-sidebar-footer">
        <button
          type="button"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? "»" : "«"}
        </button>
      </footer>
      {menu && (
        <RowMenu
          {...menu}
          dismiss={dismiss}
          actions={[
            {
              label: "Open",
              disabled: !liveRows.length,
              run: () => {
                if (menu.kind === "pane" && liveRows[0]) choose(liveRows[0]);
                else openGroup(menuRows, menuName ?? "Tab");
              },
            },
            {
              label: "Open space",
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
    </aside>
  );
}
