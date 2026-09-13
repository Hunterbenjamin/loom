import type { TaskId } from "@loom/core";
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
import {
  attentionPanes,
  sameTerminal,
  spaces,
  terminalName,
} from "./selectors.js";
import "./workbench.css";
import { NewTerminalDialog } from "./new-terminal.js";
import { Sidebar } from "./sidebar.js";

type Panel = {
  id: string;
  target?: PaneIdentity;
  name?: string;
  system?: "main" | "operator";
};
type Tab = { id: string; name: string; panels: Panel[] };
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

const PanelLabel = ({
  target,
  name,
}: {
  target?: PaneIdentity;
  name?: string;
}) => {
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
          ? `${pane.role ?? pane.windowName ?? pane.title ?? pane.command} · ${pane.paneId}${pane.dead ? " · exited" : pane.unavailable ? " · unavailable" : ""}`
          : "Pane unavailable"
        : (name ?? "Terminal")}
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
  const runs = useStore((s) => s.snapshot.runs);
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
            <PanelLabel
              target={p.target}
              name={
                p.system === "main"
                  ? "Main"
                  : p.system === "operator"
                    ? "Operator"
                    : p.name
              }
            />
            <button
              type="button"
              aria-label={
                p.system ||
                runs.some(
                  (run) =>
                    !run.endedAt &&
                    run.pane &&
                    p.target &&
                    sameTerminal(run.pane, p.target),
                )
                  ? "Hide agent view"
                  : "Close terminal"
              }
              title={
                p.system ||
                runs.some(
                  (run) =>
                    !run.endedAt &&
                    run.pane &&
                    p.target &&
                    sameTerminal(run.pane, p.target),
                )
                  ? "Hide view; the agent keeps running"
                  : "Close terminal session"
              }
              onClick={() => close(p.id)}
            >
              ×
            </button>
          </header>
          <TerminalSession
            panelId={p.id}
            pane={p.target}
            lead={p.system === "main"}
            operator={p.system === "operator"}
            live={live}
            theme={theme}
            label={p.system === "main" ? "Main" : "Workbench"}
          />
        </fieldset>
      ))}
    </div>
  );
});

export function Workbench() {
  const store = useStoreApi();
  const panes = useStore((s) => s.panes);
  const unavailable = useStore((s) => s.panesUnavailable);
  const connection = useStore((s) => s.connection);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const initialized = useRef(false);
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const [focused, setFocused] = useState(tabs[0]?.panels[0]?.id ?? "");
  const [zoom, setZoom] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState("");
  const [pendingTab, setPendingTab] = useState<{
    taskId?: TaskId;
    split?: { tabId: string; panelId: string; direction: "right" | "below" };
  } | null>(null);
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
  const newTab = () => setPendingTab({});
  const createTab = async (name: string) => {
    const pending = pendingTab;
    const result = await store.command(
      pending?.taskId
        ? {
            kind: "create_scratch",
            taskId: pending.taskId,
            key: crypto.randomUUID(),
            label: name,
          }
        : {
            kind: "open_workbench_terminal",
            key: crypto.randomUUID(),
            label: name,
          },
    );
    if (!result.ok) throw new Error(result.error.message);
    const target =
      result.result.kind === "scratch_created"
        ? identity(result.result.pane)
        : result.result.kind === "attach_session" &&
            "identity" in result.result.target &&
            result.result.target.identity === "pane"
          ? result.result.target.target
          : null;
    if (!target) throw new Error("Terminal creation was not confirmed");
    const p = { ...newPanel(target), name };
    const split = pending?.split;
    const grid = split && grids.current.get(split.tabId);
    if (split && grid?.getPanel(split.panelId)) {
      grid.addPanel({
        id: p.id,
        component: "cell",
        minimumWidth: 280,
        minimumHeight: 150,
        position: { referencePanel: split.panelId, direction: split.direction },
      });
      setTabs((ts) =>
        ts.map((t) =>
          t.id === split.tabId ? { ...t, panels: [...t.panels, p] } : t,
        ),
      );
      setActive(split.tabId);
    } else {
      const tab = { id: crypto.randomUUID(), name, panels: [p] };
      setTabs((ts) => [...ts, tab]);
      setActive(tab.id);
    }
    setPendingTab(null);
    setZoom(null);
    keyboardFocus(p.id);
  };
  const openPinned = (system: "main" | "operator") => {
    const existing = tabs
      .flatMap((tab) => tab.panels.map((panel) => ({ tab, panel })))
      .find(({ panel }) => panel.system === system);
    if (existing) {
      setActive(existing.tab.id);
      keyboardFocus(existing.panel.id);
      return;
    }
    const panel: Panel = { id: crypto.randomUUID(), system };
    const tab = {
      id: crypto.randomUUID(),
      name: system === "main" ? "Main" : "Operator",
      panels: [panel],
    };
    setTabs((tabs) => [...tabs, tab]);
    setActive(tab.id);
    setZoom(null);
    keyboardFocus(panel.id);
  };
  const choose = (pane: PaneView, inNewTab = false) => {
    if (pane.dead || pane.unavailable) return;
    const current = tabs.find((tab) => tab.id === active);
    const panel = current?.panels.find((panel) => panel.id === focused);
    // A click replaces only the focused viewer; Enter always creates an independent tab.
    if (!inNewTab && current && panel && !panel.system) {
      if (panel.target && sameTerminal(panel.target, pane)) {
        keyboardFocus(panel.id);
        return;
      }
      setTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === current.id
            ? {
                ...tab,
                name: tab.panels.length === 1 ? terminalName(pane) : tab.name,
                panels: tab.panels.map((p) =>
                  p.id === panel.id ? { ...p, target: identity(pane) } : p,
                ),
              }
            : tab,
        ),
      );
      setZoom(null);
      keyboardFocus(panel.id);
      return;
    }
    // Pinned agent tabs retain their identity; opening here creates a regular viewer.
    const next = newPanel(identity(pane));
    const tab = {
      id: crypto.randomUUID(),
      name: terminalName(pane),
      panels: [next],
    };
    setTabs((tabs) => [...tabs, tab]);
    setActive(tab.id);
    setZoom(null);
    keyboardFocus(next.id);
  };
  useEffect(() => {
    if (unavailable || connection !== "connected") return;
    // The host owns existence. A native exit/close removes every view of that terminal.
    setTabs((ts) => {
      const next = ts
        .map((tab) => ({
          ...tab,
          panels: tab.panels.filter(
            (panel) =>
              !panel.target ||
              panes.some(
                (pane) =>
                  !pane.dead &&
                  sameTerminal(pane, panel.target as PaneIdentity),
              ),
          ),
        }))
        .filter((tab) => tab.panels.length);
      return next.length === ts.length &&
        next.every((tab, i) => tab.panels.length === ts[i]?.panels.length)
        ? ts
        : next;
    });
    if (!initialized.current) {
      initialized.current = true;
      const first = spaces(panes)
        .flatMap((space) => space.tabs.flatMap((tab) => tab.panes))
        .find(({ pane }) => !pane.dead && !pane.unavailable);
      if (first) {
        const panel = newPanel(identity(first.pane));
        const tab = {
          id: crypto.randomUUID(),
          name: terminalName(first.pane),
          panels: [panel],
        };
        setTabs((ts) => (ts.length ? ts : [tab]));
        setActive(tab.id);
        setFocused(panel.id);
      }
    }
  }, [panes, unavailable, connection]);
  useEffect(() => {
    const tab = tabs.find((t) => t.id === active) ?? tabs[0];
    if (
      tab &&
      (!tabs.some((t) => t.id === active) ||
        !tab.panels.some((p) => p.id === focused))
    ) {
      setActive(tab.id);
      keyboardFocus(tab.panels[0]?.id ?? "");
      setZoom(null);
    }
  }, [tabs, active, focused, keyboardFocus]);
  const closing = useRef(new Set<string>());
  const close = (id: string) => {
    const panel = tabs.flatMap((t) => t.panels).find((p) => p.id === id);
    if (!panel || closing.current.has(id)) return;
    const target = panel.target;
    const managed =
      panel.system ||
      store
        .getState()
        .snapshot.runs.some(
          (run) =>
            !run.endedAt &&
            run.pane &&
            target &&
            sameTerminal(run.pane, target),
        );
    const remove = () => {
      setZoom(null);
      setTabs((ts) =>
        ts
          .map((t) => ({
            ...t,
            panels: t.panels.filter(
              (p) =>
                p.id !== id &&
                (managed ||
                  !target ||
                  !p.target ||
                  !sameTerminal(p.target, target)),
            ),
          }))
          .filter((t) => t.panels.length),
      );
    };
    if (managed || !target) {
      remove();
      return;
    }
    closing.current.add(id);
    void store
      .command({ kind: "close_terminal", target })
      .then((result) => {
        if (!result.ok) throw new Error(result.error.message);
        if (result.result.kind !== "terminal_closed")
          throw new Error("Terminal closure was not confirmed");
        remove();
      })
      .catch((error: unknown) => setError(String(error)))
      .finally(() => closing.current.delete(id));
  };
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
      setPendingTab({
        split: {
          tabId: tab.id,
          panelId: focused,
          direction: action === "split-right" ? "right" : "below",
        },
      });
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
      if (document.querySelector("dialog[open]")) return;
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
      newTab();
      return;
    }
    setPendingTab({ taskId });
  };
  return (
    <div className="workbench">
      <div className="wb-titlebar" aria-hidden="true" />
      {pendingTab && (
        <NewTerminalDialog
          initialName={`Terminal ${tabs.length + 1}`}
          create={createTab}
          cancel={() => setPendingTab(null)}
        />
      )}
      <div className="wb-body">
        <Sidebar
          filter={filter}
          setFilter={setFilter}
          choose={choose}
          newTerminal={() => newTab()}
          openPinned={openPinned}
        />
        <main className="wb-main">
          <nav className="wb-tabs" aria-label="Workbench tabs">
            {tabs.map((t) => (
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
                {t.name}
              </button>
            ))}
            <button type="button" onClick={() => newTab()}>
              ＋
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
                New terminal
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
          if (first) choose(first);
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
                  onSelect={() => {
                    setPalette(false);
                    void window.loomHost.setMode("tracker");
                  }}
                >
                  Switch to issue tracker
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
