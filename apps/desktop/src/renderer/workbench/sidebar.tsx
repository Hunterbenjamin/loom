import type { PaneIdentity, PaneView } from "@loom/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paneKey } from "../store/pane-transitions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { conversationIndicator } from "./agents.js";
import { devControlActions, useDevControlAvailable } from "./dev-controls.js";
import { RenameRow } from "./rename-row.js";
import { RowMenu } from "./row-menu.js";
import {
  type Indicator,
  spaceKey,
  spaces,
  tabKey,
  workbenchSessions,
} from "./selectors.js";
import { Status } from "./status.js";

export function Sidebar({
  filter,
  choose,
  openPinned,
  openGroup,
  hidePanels,
  copyAttach,
  selected,
  selectedSpace,
  selectedTab,
}: {
  selectedSpace?: string;
  selectedTab?: string;
  selected?: PaneIdentity | "main";
  filter: string;
  choose: (pane: PaneView, newTab?: boolean) => void;
  openGroup: (panes: PaneView[], name: string) => void;
  hidePanels: (panes: PaneView[]) => void;
  copyAttach: (pane: PaneView) => void;
  openPinned: (target: "main") => void;
}) {
  const store = useStoreApi();
  const instance = useStore((s) => s.instance);
  const devControlAvailable = useDevControlAvailable();
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
  const read = useStore((s) => s.readFinished);
  const tree = useMemo(
    () => spaces(panes, filter, runs, false, read),
    [panes, filter, runs, read],
  );
  const services = useMemo(() => workbenchSessions(panes, runs), [panes, runs]);
  const lead = useStore((s) => s.lead);
  const mainFinished = useStore((s) => s.mainFinished);
  const repo = useStore((s) => s.ui.repo);
  const [grouped, setGrouped] = useState(true);
  const agents = tree.flatMap((space) =>
    space.tabs.flatMap((tab) =>
      tab.panes
        // A dead agent pane is on its way out (the host reaps it); never list it as a greyed row.
        .filter(
          ({ pane }) =>
            (pane.provider || pane.runId || pane.agent) && !pane.dead,
        )
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
  const [menu, setMenu] = useState<{
    kind: "space" | "tab" | "pane" | "main";
    key: string;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  const [editingRow, setEditingRow] = useState<{
    kind: "space" | "tab" | "pane";
    key: string;
  } | null>(null);
  const dismiss = useCallback(() => setMenu(null), []);
  // Resolve against the full inventory, never the filtered descendants or a stale row object.
  const rowPanes = (kind: "space" | "tab" | "pane" | "main", key: string) =>
    kind === "main"
      ? []
      : panes
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
  const renameAllowed = !(
    menu?.kind === "space" &&
    ["loom-coordinator", "loom-desktop"].includes(
      menuRows[0]?.sessionName ?? "",
    )
  );
  const rowMenu = (kind: "space" | "tab" | "pane" | "main", key: string) => ({
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
      <span className="instance-badge">{instance}</span>
      <section className="wb-terminals" aria-label="Terminal tree">
        <div className="wb-section-heading">
          <h2>spaces</h2>
        </div>
        {unavailable && (
          <p role="status">
            Terminal host unavailable. Showing last known terminals.
          </p>
        )}
        <div className="wb-terminal-list">
          {tree.map((space) => (
            <section key={space.key} aria-label={space.label}>
              <div className="wb-space-row" {...rowMenu("space", space.key)}>
                <RenameRow
                  kind="space"
                  pane={space.tabs[0]?.panes[0]?.pane}
                  name={space.label}
                  title={space.tabs[0]?.panes[0]?.pane.spaceTitle ?? null}
                  editing={
                    editingRow?.kind === "space" && editingRow.key === space.key
                  }
                  onEditingChange={(editing) => {
                    setEditingRow(
                      editing ? { kind: "space", key: space.key } : null,
                    );
                  }}
                  className="wb-space"
                  current={
                    selectedSpace === space.key ||
                    (!!selectedPane && spaceKey(selectedPane) === space.key)
                  }
                  ariaLabel={`Open space ${space.label}`}
                  toggle={() =>
                    openGroup(rowPanes("space", space.key), space.label)
                  }
                >
                  {/* A space is a place, not an agent: its row keeps the plain circle and
                      the rows inside it carry the live indicators. */}
                  <span className="wb-status idle" aria-hidden="true">
                    ○
                  </span>
                  <span className="wb-row-copy">
                    <span className="wb-tree-name">{space.label}</span>
                    <small
                      className="wb-space-branch"
                      title={space.branch ?? "Branch unavailable"}
                    >
                      {space.subtext ?? space.branch ?? "—"}
                    </small>
                  </span>
                </RenameRow>
              </div>
              {space.tabs.map((tab) => (
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
                      title={tab.panes[0]?.pane.tabTitle ?? null}
                      editing={
                        editingRow?.kind === "tab" && editingRow.key === tab.key
                      }
                      onEditingChange={(editing) => {
                        setEditingRow(
                          editing ? { kind: "tab", key: tab.key } : null,
                        );
                      }}
                      ariaLabel={`Open tab ${tab.name}`}
                      disabled={
                        !rowPanes("tab", tab.key).some(
                          (pane) =>
                            !unavailable && !pane.unavailable && !pane.dead,
                        )
                      }
                      toggle={() =>
                        openGroup(rowPanes("tab", tab.key), tab.name)
                      }
                    >
                      <Status state={tab.indicator} />
                      <span className="wb-tree-name" title={tab.windowName}>
                        {tab.name}
                      </span>
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
              {...rowMenu("main", "main")}
              onClick={() => openPinned("main")}
              title={lead.reason ?? "Open Main terminal"}
            >
              <Status
                state={conversationIndicator(lead.status, mainFinished)}
              />
              <span className="wb-row-copy">
                <strong>Main</strong>
                <small>{lead.status}</small>
              </span>
            </button>
          </div>
        </section>
        <div className="wb-agent-list">
          {agents.map(({ pane, name, indicator, space, tab }) => (
            <RenameRow
              key={pane.id}
              kind="pane"
              pane={pane}
              name={name}
              title={pane.paneTitle}
              dataPaneKey={paneKey(pane)}
              className={`wb-agent-row ${pane.dead ? "dead" : ""}`}
              ariaLabel={`Open agent ${space.label} ${tab.name} ${pane.paneId}`}
              current={isSelected(pane)}
              disabled={unavailable || pane.unavailable || pane.dead}
              editing={
                editingRow?.kind === "pane" && editingRow.key === paneKey(pane)
              }
              onEditingChange={(editing) => {
                setEditingRow(
                  editing ? { kind: "pane", key: paneKey(pane) } : null,
                );
              }}
              onContextMenu={rowMenu("pane", paneKey(pane)).onContextMenu}
              toggle={() => choose(pane)}
              onKeyDown={(e) => {
                rowMenu("pane", paneKey(pane)).onKeyDown(e);
                if (e.key === "Enter") {
                  e.preventDefault();
                  choose(pane, true);
                }
              }}
            >
              <Status state={indicator} />
              <span className="wb-row-copy">
                <span className="wb-tree-name">
                  <strong>{name}</strong>
                </span>
                <small>
                  {pane.taskName ?? pane.issueKey ?? "Issue"} ·{" "}
                  {pane.provider ?? pane.agent ?? "—"}
                </small>
              </span>
            </RenameRow>
          ))}
          {!agents.length && (
            <p className="wb-muted">
              {filter ? "No matching agents" : "No agents"}
            </p>
          )}
        </div>
      </section>
      {!!services.length && (
        <section
          className="wb-workbench-sessions"
          aria-label="Workbench terminals"
        >
          {services.map((service) => {
            const servicePanes = rowPanes("space", service.key);
            return (
              <button
                type="button"
                key={service.key}
                className="wb-tree-row wb-agent-row"
                aria-label={`Open ${service.label} terminal`}
                aria-current={
                  selectedSpace === service.key ||
                  (!!selectedPane && spaceKey(selectedPane) === service.key)
                    ? "true"
                    : undefined
                }
                disabled={
                  !servicePanes.some(
                    (pane) => !unavailable && !pane.unavailable && !pane.dead,
                  )
                }
                {...rowMenu("space", service.key)}
                onClick={() => openGroup(servicePanes, service.name)}
                title={`Open ${service.label} terminal`}
              >
                <Status state={service.indicator} />
                <span className="wb-tree-name">{service.label}</span>
              </button>
            );
          })}
        </section>
      )}
      {menu && (
        <RowMenu
          {...menu}
          dismiss={dismiss}
          actions={
            menu.kind === "main"
              ? [
                  {
                    label: "Open terminal",
                    disabled: !repo,
                    run: () => openPinned("main"),
                  },
                  {
                    label: "Open as chat",
                    disabled: !repo,
                    run: () => {
                      if (!repo) return;
                      window.dispatchEvent(
                        new CustomEvent("loom:open-chat", {
                          detail: { kind: "lead", repoId: repo },
                        }),
                      );
                    },
                  },
                ]
              : [
                  ...devControlActions(
                    devControlAvailable,
                    menu.kind === "space" ? menuName : undefined,
                  ),
                  {
                    label: "Open",
                    disabled: !liveRows.length,
                    run: () => {
                      if (menu.kind === "pane" && liveRows[0])
                        choose(liveRows[0]);
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
                    // Without this a row that is not an open panel cannot be closed at all:
                    // Cmd+W closes the focused panel, and the sidebar had no close of its own,
                    // so a finished agent's pane or a leftover scratch terminal stayed forever.
                    label:
                      menu.kind === "space" ? "Close space" : "Close terminal",
                    disabled: !menuRows.length,
                    run: () => {
                      const rows = menuRows;
                      if (!rows.length) return;
                      if (
                        menu.kind === "space" &&
                        !window.confirm(
                          `Close ${menuName ?? "this space"} and every terminal in it?`,
                        )
                      )
                        return;
                      for (const target of menu.kind === "space"
                        ? rows.slice(0, 1)
                        : rows)
                        void store
                          .command({
                            kind: "close_terminal",
                            target: {
                              hostGeneration: target.hostGeneration,
                              sessionName: target.sessionName,
                              windowId: target.windowId,
                              paneId: target.paneId,
                            },
                            scope: menu.kind === "space" ? "session" : "pane",
                          })
                          .then((outcome) => {
                            if (!outcome.ok)
                              window.alert(outcome.error.message);
                          });
                    },
                  },
                  {
                    label: "Rename",
                    disabled: !liveRows.length || !renameAllowed,
                    run: () => {
                      if (menu.kind === "main") return;
                      setEditingRow({ kind: menu.kind, key: menu.key });
                    },
                  },
                  ...(menu.kind === "pane" &&
                  menuRows[0]?.runId &&
                  menuRows[0]?.taskId
                    ? [
                        {
                          label: "Open as chat",
                          run: () => {
                            const runId = menuRows[0]?.runId;
                            if (runId)
                              window.dispatchEvent(
                                new CustomEvent("loom:open-chat", {
                                  detail: { kind: "run", runId },
                                }),
                              );
                          },
                        },
                        {
                          label: "Restart agent",
                          reason:
                            "Fresh session for this run; the replacement appears once the previous agent stops",
                          run: () => {
                            const target = menuRows[0];
                            if (!target?.runId || !target.taskId) return;
                            void store
                              .command({
                                kind: "human",
                                taskId: target.taskId,
                                command: {
                                  type: "restart_run",
                                  runId: target.runId,
                                },
                              })
                              .then((outcome) => {
                                if (!outcome.ok)
                                  window.alert(outcome.error.message);
                              });
                          },
                        },
                      ]
                    : []),
                  {
                    label: "Copy attach command",
                    disabled: !liveRows.length,
                    reason: "Attach to the first live pane in this row",
                    run: () => {
                      if (liveRows[0]) copyAttach(liveRows[0]);
                    },
                  },
                  {
                    label:
                      menu.kind === "space"
                        ? "Close space"
                        : menu.kind === "tab"
                          ? "Close tab"
                          : "Close pane",
                    disabled: !liveRows.length,
                    reason:
                      menu.kind === "space"
                        ? "Kills every process in this space"
                        : menu.kind === "tab"
                          ? "Kills every process in this tab"
                          : "Kills this pane's process",
                    run: () => {
                      const target = liveRows[0];
                      if (!target) return;
                      const count = liveRows.length;
                      if (
                        menu.kind !== "pane" &&
                        !window.confirm(
                          `Close ${menu.kind} "${menuName ?? ""}" and kill ${count} process${count === 1 ? "" : "es"}?`,
                        )
                      )
                        return;
                      void store
                        .command({
                          kind: "close_terminal",
                          target: {
                            hostGeneration: target.hostGeneration,
                            sessionName: target.sessionName,
                            windowId: target.windowId,
                            paneId: target.paneId,
                          },
                          scope:
                            menu.kind === "space"
                              ? "session"
                              : menu.kind === "tab"
                                ? "window"
                                : "pane",
                        })
                        .then((outcome) => {
                          if (outcome.ok) hidePanels(menuRows);
                          else window.alert(outcome.error.message);
                        });
                    },
                  },
                ]
          }
        />
      )}
    </aside>
  );
}
