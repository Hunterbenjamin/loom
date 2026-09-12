import type { PaneIdentity, PaneView } from "@loom/protocol";
import { Command } from "cmdk";
import {
  type GridviewApi,
  GridviewReact,
  type IGridviewPanelProps,
  Orientation,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { LeadBar } from "../ui/lead.js";
import { TerminalSession } from "../ui/terminal.js";
import { type Action, actions, prefixKeys } from "./actions.js";
import { attentionPanes, spaces } from "./selectors.js";
import "./workbench.css";

type Panel = { id: string; target?: PaneIdentity };
type Tab = { id: string; panels: Panel[] };
type Rect = { left: number; top: number; width: number; height: number };
const newPanel = (target?: PaneIdentity): Panel => ({
  id: crypto.randomUUID(),
  target,
});
const identity = (p: PaneView): PaneIdentity => ({
  hostGeneration: p.hostGeneration,
  sessionName: p.sessionName,
  windowId: p.windowId,
  paneId: p.paneId,
});
const Placeholder = ({ api }: IGridviewPanelProps) => (
  <div className="wb-cell" data-cell={api.id} />
);
const components = { cell: Placeholder };

function Sidebar({
  filter,
  setFilter,
  choose,
}: {
  filter: string;
  setFilter: (s: string) => void;
  choose: (p: PaneView, tab: boolean) => void;
}) {
  const panes = useStore((s) => s.panes);
  const unavailable = useStore((s) => s.panesUnavailable);
  const groups = spaces(panes, filter);
  useEffect(() => {
    window.loomHost.interactive();
  }, []);
  return (
    <aside className="wb-sidebar" aria-label="Spaces and agents">
      <input
        id="agent-filter"
        aria-label="Find agent"
        placeholder="Find an agent…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {unavailable && (
        <p role="status">
          Pane host unavailable. Showing last known inventory.
        </p>
      )}
      {!groups.length && (
        <p>
          {panes.length ? "No matching agents" : "No panes on this instance"}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.name}>
          <h3 title={g.name}>{g.label}</h3>
          {g.panes.map((p) => (
            <button
              type="button"
              key={p.id}
              className={p.dead ? "wb-agent dead" : "wb-agent"}
              onClick={() => choose(p, false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  choose(p, true);
                }
              }}
              title={`${p.startCwd}\n${p.attachedClients} session-group clients`}
            >
              <span>
                {p.attention ? "● " : ""}
                {p.role
                  ? `${p.role} · ${p.provider}`
                  : p.title || p.windowName || p.command || p.paneId}
              </span>
              <small>
                {p.windowName} · {p.paneId} ·{" "}
                {p.dead
                  ? `exited ${p.exitStatus ?? "unknown"}`
                  : (p.status ?? p.command)}
              </small>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}

const PanelLabel = ({ target }: { target?: PaneIdentity }) => {
  const pane = useStore((s) =>
    s.panes.find(
      (p) =>
        target &&
        p.hostGeneration === target.hostGeneration &&
        p.paneId === target.paneId,
    ),
  );
  return (
    <span>
      {target
        ? pane
          ? `${pane.role ?? pane.title ?? pane.command} · ${pane.paneId}${pane.dead ? " · exited" : pane.unavailable ? " · unavailable" : ""}`
          : "Pane unavailable"
        : "Choose an agent"}
    </span>
  );
};

/** A grid lays out empty cells. Terminals are stable siblings, even when the library moves cells. */
const TabGrid = memo(function TabGrid({
  tab,
  active,
  focused,
  focus,
  register,
  zoom,
  close,
}: {
  tab: Tab;
  active: boolean;
  focused: string;
  focus: (id: string) => void;
  register: (id: string, api: GridviewApi | null) => void;
  zoom: string | null;
  close: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<GridviewApi | null>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const live = useStore((s) => s.live);
  const theme = useStore((s) => s.ui.theme);
  const measure = useCallback(() => {
    const element = host.current;
    if (!element?.clientWidth) return;
    const base = element.getBoundingClientRect();
    const next: Record<string, Rect> = {};
    for (const cell of element.querySelectorAll<HTMLElement>("[data-cell]")) {
      const r = cell.getBoundingClientRect();
      next[cell.dataset.cell as string] = {
        left: r.left - base.left,
        top: r.top - base.top,
        width: r.width,
        height: r.height,
      };
    }
    setRects((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(() => {
      const element = host.current;
      if (element?.clientWidth && element.clientHeight)
        api.current?.layout(element.clientWidth, element.clientHeight);
      measure();
    });
    if (host.current) observer.observe(host.current);
    // React grid cells can mount after the grid's layout callback. Observe only those
    // placeholders, never the terminal DOM, so newly created tabs get panel bounds.
    const cells = new MutationObserver(measure);
    const gridElement = host.current?.querySelector(".dv-grid-view");
    if (gridElement)
      cells.observe(gridElement, { childList: true, subtree: true });
    return () => {
      cells.disconnect();
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);
  useEffect(() => {
    const grid = api.current;
    if (!grid) return;
    for (const p of grid.panels)
      if (!tab.panels.some((x) => x.id === p.id)) grid.removePanel(p);
    requestAnimationFrame(measure);
  }, [tab, measure]);
  useLayoutEffect(() => {
    if (active && host.current) {
      api.current?.layout(host.current.clientWidth, host.current.clientHeight);
      requestAnimationFrame(measure);
    }
  }, [active, measure]);
  useEffect(() => () => register(tab.id, null), [register, tab.id]);
  return (
    <div
      className="wb-tab"
      ref={host}
      style={{ display: active ? "block" : "none" }}
    >
      <GridviewReact
        disableAutoResizing
        orientation={Orientation.HORIZONTAL}
        components={components}
        onReady={(e) => {
          api.current = e.api;
          if (host.current?.clientWidth && host.current.clientHeight)
            e.api.layout(host.current.clientWidth, host.current.clientHeight);
          register(tab.id, e.api);
          for (const p of tab.panels)
            e.api.addPanel({
              id: p.id,
              component: "cell",
              minimumWidth: 280,
              minimumHeight: 150,
            });
          if (host.current?.clientWidth && host.current.clientHeight)
            e.api.layout(host.current.clientWidth, host.current.clientHeight);
          e.api.onDidLayoutChange(() => requestAnimationFrame(measure));
          requestAnimationFrame(measure);
        }}
      />
      {tab.panels.map((p) => (
        <fieldset
          aria-label="Terminal panel"
          key={p.id}
          data-panel={p.id}
          className={`wb-panel ${focused === p.id ? "focused" : ""}`}
          style={
            zoom === p.id
              ? { inset: 0, zIndex: 3 }
              : {
                  ...rects[p.id],
                  visibility:
                    !rects[p.id] || (zoom && zoom !== p.id)
                      ? "hidden"
                      : "visible",
                }
          }
          onFocusCapture={() => focus(p.id)}
          onPointerDown={() => focus(p.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = e.dataTransfer.getData("application/loom-panel");
            const source = api.current?.getPanel(from);
            if (!source || from === p.id) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            const direction =
              Math.min(x, 1 - x) < Math.min(y, 1 - y)
                ? x < 0.5
                  ? "left"
                  : "right"
                : y < 0.5
                  ? "above"
                  : "below";
            api.current?.movePanel(source, { reference: p.id, direction });
            requestAnimationFrame(measure);
          }}
        >
          <header
            role="toolbar"
            aria-label="Panel controls"
            draggable
            onDragStart={(e) =>
              e.dataTransfer.setData("application/loom-panel", p.id)
            }
          >
            <PanelLabel target={p.target} />
            <button
              type="button"
              aria-label="Close panel"
              onClick={() => close(p.id)}
            >
              ×
            </button>
          </header>
          {p.target ? (
            <TerminalSession
              panelId={p.id}
              pane={p.target}
              live={live}
              theme={theme}
              label="Workbench"
            />
          ) : (
            <div className="wb-empty">
              Click an agent to attach here. Enter opens a new tab.
            </div>
          )}
        </fieldset>
      ))}
    </div>
  );
});

export function Workbench() {
  const store = useStoreApi();
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: crypto.randomUUID(), panels: [newPanel()] },
  ]);
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const [focused, setFocused] = useState(tabs[0]?.panels[0]?.id ?? "");
  const [zoom, setZoom] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState("");
  const grids = useRef(new Map<string, GridviewApi>());
  const register = useCallback((id: string, api: GridviewApi | null) => {
    if (api) grids.current.set(id, api);
    else grids.current.delete(id);
  }, []);
  const focus = useCallback((id: string) => {
    setFocused(id);
  }, []);
  const keyboardFocus = useCallback((id: string) => {
    setFocused(id);
    requestAnimationFrame(() =>
      (window.loom.terms?.[id] as { focus(): void } | undefined)?.focus(),
    );
  }, []);
  const newTab = (target?: PaneIdentity) => {
    const p = newPanel(target);
    const tab = { id: crypto.randomUUID(), panels: [p] };
    setTabs((ts) => [...ts, tab]);
    setActive(tab.id);
    setZoom(null);
    keyboardFocus(p.id);
  };
  const choose = (pane: PaneView, tab: boolean) => {
    if (tab || !tabs.length) {
      newTab(identity(pane));
      return;
    }
    setTabs((ts) =>
      ts.map((t) =>
        t.id === active
          ? {
              ...t,
              panels: t.panels.map((p) =>
                p.id === focused ? { ...p, target: identity(pane) } : p,
              ),
            }
          : t,
      ),
    );
    keyboardFocus(focused);
  };
  const close = useCallback(
    (id: string) => {
      setZoom(null);
      setTabs((ts) => {
        const next = ts
          .map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== id) }))
          .filter((t) => t.panels.length);
        const tab = next.find((t) => t.id === active) ?? next[0];
        if (tab) {
          setActive(tab.id);
          keyboardFocus(tab.panels[0]?.id ?? "");
        }
        return next;
      });
    },
    [active, keyboardFocus],
  );
  const dispatch = (action: Action) => {
    const tab = tabs.find((t) => t.id === active);
    const grid = grids.current.get(active);
    if (action === "new") return newTab();
    if (action === "jump") {
      document.getElementById("agent-filter")?.focus();
      return;
    }
    if (action === "help") {
      setHelp(true);
      return;
    }
    if (action === "close") return close(focused);
    if (action === "zoom") {
      setZoom((z) => (z ? null : focused));
      return;
    }
    if (action === "next" || action === "previous") {
      const i = tabs.findIndex((t) => t.id === active);
      const t =
        tabs[(i + (action === "next" ? 1 : tabs.length - 1)) % tabs.length];
      if (t) {
        setActive(t.id);
        setZoom(null);
        keyboardFocus(t.panels[0]?.id ?? "");
      }
      return;
    }
    if (!tab || !grid) return;
    if (action === "split-right" || action === "split-down") {
      const p = newPanel(tab.panels.find((p) => p.id === focused)?.target);
      grid.addPanel({
        id: p.id,
        component: "cell",
        minimumWidth: 280,
        minimumHeight: 150,
        position: {
          referencePanel: focused,
          direction: action === "split-right" ? "right" : "below",
        },
      });
      setTabs((ts) =>
        ts.map((t) =>
          t.id === active ? { ...t, panels: [...t.panels, p] } : t,
        ),
      );
      setZoom(null);
      keyboardFocus(p.id);
      return;
    }
    const current = document
      .querySelector(`[data-panel="${focused}"]`)
      ?.getBoundingClientRect();
    if (!current) return;
    const candidates = tab.panels
      .filter((p) => p.id !== focused)
      .map((p) => ({
        p,
        r: document
          .querySelector(`[data-panel="${p.id}"]`)
          ?.getBoundingClientRect(),
      }))
      .filter((v): v is { p: Panel; r: DOMRect } => !!v.r)
      .map((v) => ({
        ...v,
        dx: (v.r.left + v.r.right - current.left - current.right) / 2,
        dy: (v.r.top + v.r.bottom - current.top - current.bottom) / 2,
      }))
      .filter((v) =>
        action === "left"
          ? v.dx < -1
          : action === "right"
            ? v.dx > 1
            : action === "up"
              ? v.dy < -1
              : v.dy > 1,
      )
      .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
    if (candidates[0]) keyboardFocus(candidates[0].p.id);
  };
  const latest = useRef({ dispatch, focused });
  latest.current = { dispatch, focused };
  useEffect(() => {
    const prefix = prefixKeys(
      (a) => latest.current.dispatch(a),
      () =>
        (
          window.loom.terms?.[latest.current.focused] as
            | { input(data: string, user?: boolean): void }
            | undefined
        )?.input("\x01", true),
    );
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setPalette((v) => !v);
        return;
      }
      if (prefix(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const scratch = async () => {
    const target = tabs
      .find((t) => t.id === active)
      ?.panels.find((p) => p.id === focused)?.target;
    const taskId = store
      .getState()
      .panes.find(
        (p) =>
          target &&
          p.hostGeneration === target.hostGeneration &&
          p.paneId === target.paneId,
      )?.taskId;
    if (!taskId) {
      setError("Select a task agent to create a scratch shell.");
      return;
    }
    const result = await store.command({
      kind: "create_scratch",
      taskId,
      key: crypto.randomUUID(),
    });
    if (result.ok && result.result.kind === "scratch_created")
      newTab(identity(result.result.pane));
    else if (!result.ok) setError(result.error.message);
  };
  return (
    <div className="workbench">
      <div className="wb-body">
        <Sidebar filter={filter} setFilter={setFilter} choose={choose} />
        <main className="wb-main">
          <nav className="wb-tabs" aria-label="Workbench tabs">
            {tabs.map((t, i) => (
              <button
                type="button"
                key={t.id}
                aria-pressed={active === t.id}
                onClick={() => {
                  setActive(t.id);
                  setZoom(null);
                  keyboardFocus(t.panels[0]?.id ?? "");
                }}
              >
                Terminal {i + 1}
              </button>
            ))}
            <button type="button" onClick={() => newTab()}>
              ＋
            </button>
            <button type="button" onClick={() => setPalette(true)}>
              Commands ⌘K
            </button>
            <button type="button" onClick={() => void scratch()}>
              Scratch shell
            </button>
          </nav>
          <div className="wb-layout">
            {tabs.map((t) => (
              <TabGrid
                key={t.id}
                tab={t}
                active={active === t.id}
                focused={focused}
                focus={focus}
                register={register}
                zoom={active === t.id ? zoom : null}
                close={close}
              />
            ))}
            {!tabs.length && (
              <button type="button" onClick={() => newTab()}>
                Open an empty tab
              </button>
            )}
          </div>
          {error && (
            <div role="alert">
              {error}
              <button type="button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
        </main>
      </div>
      <LeadBar
        onAttention={() => {
          setFilter("");
          const first = attentionPanes(store.getState().panes)[0];
          if (first) choose(first, false);
        }}
      />
      {palette && (
        <div
          className="scrim"
          role="dialog"
          aria-label="Workbench commands"
          aria-modal="true"
          onKeyDown={(e) => {
            if (e.key === "Escape") setPalette(false);
          }}
        >
          <div>
            <Command label="Workbench commands" loop>
              <button type="button" onClick={() => setPalette(false)}>
                Close
              </button>
              <Command.Input autoFocus placeholder="Type a command…" />
              <Command.List>
                {actions.map((a) => (
                  <Command.Item
                    key={a.id}
                    onSelect={() => {
                      setPalette(false);
                      dispatch(a.id);
                    }}
                  >
                    {a.label} <kbd>Ctrl+A {a.key}</kbd>
                  </Command.Item>
                ))}
                <Command.Item
                  onSelect={() => {
                    setPalette(false);
                    void scratch();
                  }}
                >
                  Scratch shell
                </Command.Item>
                <Command.Item
                  onSelect={() => void window.loomHost.openWindow("workbench")}
                >
                  New Workbench
                </Command.Item>
                <Command.Item
                  onSelect={() => void window.loomHost.openWindow("tracker")}
                >
                  New Tracker
                </Command.Item>
              </Command.List>
            </Command>
          </div>
        </div>
      )}
      {help && (
        <div className="scrim">
          <div className="wb-help">
            <h2>Workbench shortcuts</h2>
            {actions.map((a) => (
              <p key={a.id}>
                <kbd>Ctrl+A {a.key}</kbd> {a.label}
              </p>
            ))}
            <p>
              Prefix expires after 1.5 seconds. Escape cancels. Ctrl+A Ctrl+A
              sends literal Ctrl+A.
            </p>
            <button type="button" onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
