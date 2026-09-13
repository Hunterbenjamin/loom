import type { PaneView } from "@loom/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { paneKey } from "../store/pane-transitions.js";
import { useStore, useStoreApi } from "../store/react.js";
import { type Indicator, spaces } from "./selectors.js";

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
}: {
  filter: string;
  setFilter: (value: string) => void;
  choose: (pane: PaneView, newTab?: boolean) => void;
  newTerminal: () => void;
  openPinned: (target: "main" | "operator") => void;
}) {
  const store = useStoreApi();
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    const animations = new Set<Animation>();
    const stop = store.subscribePaneTransitions((pane) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const pinned = ["loom-lead", "loom-main"].includes(pane.sessionName)
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
                title={space.name}
              >
                <span aria-hidden="true">
                  {expanded(space.key) ? "▾" : "▸"}
                </span>
                <Status state={space.indicator} />
                <span className="wb-tree-name">{space.label}</span>
              </button>
              {expanded(space.key) &&
                space.tabs.map((tab) => (
                  <section
                    className="wb-tree-tab"
                    key={tab.key}
                    aria-label={tab.name}
                  >
                    <button
                      type="button"
                      className="wb-tree-row"
                      aria-expanded={expanded(tab.key)}
                      onClick={() => toggle(tab.key)}
                    >
                      <span aria-hidden="true">
                        {expanded(tab.key) ? "▾" : "▸"}
                      </span>
                      <Status state={tab.indicator} />
                      <span className="wb-tree-name">{tab.name}</span>
                    </button>
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
                          onClick={() => choose(pane)}
                          onKeyDown={(e) => {
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
      <section className="wb-pinned" aria-label="Pinned terminals">
        <button
          type="button"
          className="wb-tree-pane"
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
