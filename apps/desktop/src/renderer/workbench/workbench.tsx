import type { RepoId } from "@loom/core";
import { runLabel } from "@loom/core";
import type { LeadTarget, PaneIdentity, PaneView } from "@loom/protocol";
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
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultKeybindingsState,
  formatBindings,
  isPrefixBinding,
  type KeybindingsState,
  matchesChord,
  parseChord,
} from "../../shared/keybindings.js";
import { useStore, useStoreApi } from "../store/react.js";
import { LeadBar } from "../ui/lead.js";
import { TerminalSession } from "../ui/terminal.js";
import { type Action, actions, bindingMatcher } from "./actions.js";
import {
  attentionPanes,
  sameTerminal,
  spaceKey,
  spaces,
  tabKey,
} from "./selectors.js";
import "./workbench.css";
import { ChimeMuteCommand } from "./chime.js";
import { DevControlCommands } from "./dev-controls.js";
import { NewTerminalDialog } from "./new-terminal.js";
import { Sidebar } from "./sidebar.js";
import { paneViewports, spaceLayout } from "./space-layout.js";

type Panel = {
  id: string;
  target?: PaneIdentity;
  name?: string;
};
type Tab = { id: string; name: string; panels: Panel[]; layout?: string };
type Rect = { left: number; top: number; width: number; height: number };
const newPanel = (target?: PaneIdentity): Panel => ({
  id: crypto.randomUUID(),
  target,
});
const identity = (p: PaneIdentity): PaneIdentity => ({
  hostGeneration: p.hostGeneration,
  sessionName: p.sessionName,
  windowId: p.windowId,
  paneId: p.paneId,
});
const Placeholder = ({ api }: IGridviewPanelProps) => (
  <div className="wb-cell" data-cell={api.id} />
);
const components = { cell: Placeholder };

const canonicalPane = (panes: PaneView[], target: LeadTarget) =>
  target.pane
    ? panes.find((pane) => sameTerminal(pane, target.pane as PaneIdentity))
    : undefined;

/** Inventory and command acknowledgements share a socket but are separate frames. */
const waitForCanonicalPane = (
  store: ReturnType<typeof useStoreApi>,
  target: LeadTarget,
): Promise<PaneView | undefined> => {
  const current = canonicalPane(store.getState().panes, target);
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    const finish = (pane?: PaneView) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(pane);
    };
    const unsubscribe = store.subscribe(() => {
      const pane = canonicalPane(store.getState().panes, target);
      if (pane) finish(pane);
    });
    const timer = setTimeout(() => finish(), 1_500);
  });
};

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
  const run = useStore((s) =>
    s.snapshot.runs.find((run) => run.id === pane?.runId),
  );
  return (
    <span>
      {target
        ? pane
          ? `${run ? runLabel(run) : (pane.windowName ?? pane.title ?? pane.command)} · ${pane.paneId}${pane.dead ? " · exited" : pane.unavailable ? " · unavailable" : ""}`
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
  zoom,
  close,
}: {
  tab: Tab;
  active: boolean;
  focused: string;
  focus: (id: string) => void;
  zoom: string | null;
  close: (id: string) => void;
}) {
  const viewports = useMemo(() => paneViewports(tab.layout), [tab.layout]);
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
  const layoutSignature = JSON.stringify([tab.layout, tab.panels]);
  useEffect(() => {
    const grid = api.current;
    if (!grid) return;
    const [layout, panels] = JSON.parse(layoutSignature) as [
      string | undefined,
      Panel[],
    ];
    grid.fromJSON(spaceLayout(panels, layout));
    requestAnimationFrame(measure);
  }, [layoutSignature, measure]);
  useLayoutEffect(() => {
    if (active && host.current) {
      api.current?.layout(host.current.clientWidth, host.current.clientHeight);
      requestAnimationFrame(measure);
    }
  }, [active, measure]);
  return (
    <div
      className="wb-tab"
      ref={host}
      data-panel-host=""
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
          e.api.fromJSON(spaceLayout(tab.panels, tab.layout));
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
            <PanelLabel target={p.target} name={p.name} />
            <button
              type="button"
              aria-label="Close panel"
              title="Close and kill this terminal"
              onClick={() => close(p.id)}
            >
              ×
            </button>
          </header>
          <TerminalSession
            panelId={p.id}
            pane={p.target}
            viewport={p.target ? viewports[p.target.paneId] : undefined}
            live={live}
            theme={theme}
            label="Workbench"
          />
        </fieldset>
      ))}
    </div>
  );
});

const spaceTabs = (rows: PaneView[], previous: Tab[] = []): Tab[] =>
  (spaces(rows, "", [], true)[0]?.tabs ?? []).map((tab) => ({
    id: tab.key,
    name: tab.name,
    layout: tab.panes[0]?.pane.windowLayout,
    panels: tab.panes
      .filter(
        ({ pane }) =>
          !pane.dead &&
          (!pane.unavailable ||
            previous.some((t) =>
              t.panels.some((p) => p.target && sameTerminal(p.target, pane)),
            )),
      )
      .map(
        ({ pane }) =>
          previous
            .flatMap((t) => t.panels)
            .find((p) => p.target && sameTerminal(p.target, pane)) ??
          newPanel(identity(pane)),
      ),
  }));

export function Workbench() {
  const store = useStoreApi();
  const panes = useStore((s) => s.panes);
  const repo = useStore((s) => s.ui.repo);
  const unavailable = useStore((s) => s.panesUnavailable);
  const connection = useStore((s) => s.connection);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const initialized = useRef(false);
  const hiddenPanes = useRef(new Set<string>());
  const pinnedRequest = useRef(0);
  const mainSelected = useRef(false);
  const openPinnedRef = useRef<(system: "main") => void>(() => {});
  const [mainTarget, setMainTarget] = useState<{
    repo: string;
    sessionId: string;
    pane: PaneIdentity;
  } | null>(null);
  const [openSpace, setOpenSpace] = useState<string | null>(null);
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const [focused, setFocused] = useState(tabs[0]?.panels[0]?.id ?? "");
  useLayoutEffect(
    () =>
      store.registerPaneFocus(() => {
        const panel = tabs
          .find((tab) => tab.id === active)
          ?.panels.find((panel) => panel.id === focused);
        return panel?.target;
      }),
    [store, tabs, active, focused],
  );
  const [zoom, setZoom] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filter, setFilter] = useState("");
  const [palette, setPalette] = useState(false);
  const paletteRuns = useStore((s) => s.snapshot.runs);
  const paletteRead = useStore((s) => s.readFinished);
  const paletteTree = useMemo(
    () => (palette ? spaces(panes, "", paletteRuns, false, paletteRead) : []),
    [palette, panes, paletteRuns, paletteRead],
  );
  const [help, setHelp] = useState(false);
  const [error, setError] = useState("");
  const [bindings, setBindings] = useState<KeybindingsState>(
    defaultKeybindingsState,
  );
  const [prefixArmed, setPrefixArmed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let pushed = false;
    const unsubscribe = window.loomHost.onKeybindingsChanged((state) => {
      pushed = true;
      if (!disposed) setBindings(state);
    });
    void window.loomHost
      .keybindings()
      .then((state) => {
        if (!disposed && !pushed) setBindings(state);
      })
      .catch(() => {
        if (!disposed && !pushed)
          setBindings({
            ...defaultKeybindingsState,
            error: "Cannot load keybindings; using defaults",
          });
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const [pendingTab, setPendingTab] = useState<{
    key: string;
    space?: boolean;
    split?: { tabId: string; panelId: string; direction: "right" | "below" };
  } | null>(null);
  const focus = useCallback((id: string) => {
    setFocused(id);
  }, []);
  // Focusing a panel counts as looking at its pane: a finished dot clears.
  useEffect(() => {
    const panel = tabs.flatMap((t) => t.panels).find((p) => p.id === focused);
    if (panel?.target) store.markPanesRead([panel.target]);
    if (panel?.target?.sessionName === `loom-lead-${store.getState().ui.repo}`)
      store.markMainRead();
  }, [focused, tabs, store]);
  const keyboardFocus = useCallback((id: string) => {
    setFocused(id);
    requestAnimationFrame(() =>
      (window.loom.terms?.[id] as { focus(): void } | undefined)?.focus(),
    );
  }, []);
  const newTab = () => setPendingTab({ key: crypto.randomUUID() });
  const newSpace = () =>
    setPendingTab({ key: crypto.randomUUID(), space: true });
  const createTab = async (name: string) => {
    if (!pendingTab) return;
    const split = pendingTab.split;
    const target = split
      ? tabs
          .find((t) => t.id === split.tabId)
          ?.panels.find((p) => p.id === split.panelId)?.target
      : panes.find(
          (p) => spaceKey(p) === openSpace && !p.dead && !p.unavailable,
        );
    if (pendingTab.space) {
      const result = await store.command({
        kind: "open_workbench_terminal",
        key: pendingTab.key,
        label: "shell",
        workspace: name,
      });
      if (!result.ok) throw new Error(result.error.message);
      const outcome = result.result;
      const created =
        outcome.kind === "scratch_created"
          ? store.getState().panes.find((p) => sameTerminal(p, outcome.pane))
          : undefined;
      if (!created) throw new Error("Space creation was not confirmed");
      openGroup([created], created.sessionName);
      setPendingTab(null);
      return;
    }
    if (openSpace && !target) throw new Error("Selected space is unavailable");
    const result = await store.command({
      kind: "open_workbench_terminal",
      key: pendingTab.key,
      label: name,
      ...(target ? { target: identity(target) } : {}),
      ...(split ? { split: split.direction } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    const outcome = result.result;
    const ref =
      outcome.kind === "scratch_created"
        ? outcome.pane
        : outcome.kind === "attach_session" &&
            "identity" in outcome.target &&
            outcome.target.identity === "pane"
          ? outcome.target.target
          : undefined;
    const created = ref
      ? store.getState().panes.find((p) => sameTerminal(p, ref))
      : undefined;
    if (!created)
      throw new Error("Terminal creation was not confirmed in inventory");
    openGroup([created], created.sessionName);
    setPendingTab(null);
  };
  const openPinned = (system: "main") => {
    const state = store.getState();
    // Opening Main counts as looking at it: its finished dot clears.
    if (system === "main") store.markMainRead();
    // A live Main is just opened, like any pane: no command, so nothing is asked of it. The
    // coordinator is only involved when there is no live pane or Main is stopped.
    if (system === "main" && state.lead.status !== "stopped") {
      const existing = state.panes.find(
        (pane) =>
          pane.sessionName === `loom-lead-${state.ui.repo}` && !pane.dead,
      );
      if (existing) {
        if (state.lead.sessionId)
          setMainTarget({
            repo: state.ui.repo,
            sessionId: state.lead.sessionId,
            pane: identity(existing),
          });
        return openGroup([existing], system);
      }
    }
    const requestedRepo = state.ui.repo;
    const request = ++pinnedRequest.current;
    void store
      .command({ kind: "open_lead_session", repoId: requestedRepo as RepoId })
      .then(async (result) => {
        if (!result.ok) throw new Error(result.error.message);
        if (
          result.result.kind !== "attach_session" ||
          !("identity" in result.result.target) ||
          result.result.target.identity !== "lead" ||
          result.result.target.repoId !== requestedRepo ||
          !result.result.target.pane ||
          result.result.target.pane.dead
        )
          throw new Error("Coordinator returned an invalid Main target");
        const target = result.result.target;
        const sessionId = target.sessionId;
        if (!sessionId)
          throw new Error("Coordinator returned a Main without a session");
        const pane = await waitForCanonicalPane(store, target);
        if (
          request !== pinnedRequest.current ||
          store.getState().ui.repo !== requestedRepo
        )
          return;
        if (!pane || pane.dead || pane.unavailable)
          throw new Error("Main terminal is not available yet");
        setMainTarget({
          repo: requestedRepo,
          sessionId,
          pane: identity(pane),
        });
        openGroup([pane], system);
      })
      .catch((error) => setError(String(error)));
  };
  openPinnedRef.current = openPinned;
  useEffect(() => {
    pinnedRequest.current += 1;
    setMainTarget((target) => (target?.repo === repo ? target : null));
    if (mainSelected.current) openPinnedRef.current("main");
  }, [repo]);
  const openGroup = (rows: PaneView[], _name: string) => {
    if (store.getState().panesUnavailable || !rows[0]) return;
    hiddenPanes.current.clear();
    const key = spaceKey(rows[0]);
    const inventory = store.getState().panes.filter((p) => spaceKey(p) === key);
    store.markPanesRead(rows);
    const next = spaceTabs(inventory, openSpace === key ? tabs : []);
    const selected =
      next.find((t) => t.id === tabKey(rows[0] as PaneView)) ?? next[0];
    if (!selected) return;
    setOpenSpace(key);
    setTabs(next);
    setActive(selected.id);
    setZoom(null);
    keyboardFocus(
      selected.panels.find(
        (p) => p.target && sameTerminal(p.target, rows[0] as PaneView),
      )?.id ??
        selected.panels[0]?.id ??
        "",
    );
  };
  const hasPanels = (rows: PaneView[]) =>
    !!tabs
      .find((tab) => tab.id === active)
      ?.panels.some(
        (panel) =>
          panel.target &&
          rows.some((pane) => sameTerminal(pane, panel.target as PaneIdentity)),
      );
  const hidePanels = (rows: PaneView[]) => {
    for (const pane of rows) hiddenPanes.current.add(pane.id);
    // This menu closes viewers only, including human shells. Other tabs keep their clients.
    setZoom(null);
    setTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === active
          ? {
              ...tab,
              panels: tab.panels.filter(
                (panel) =>
                  !panel.target ||
                  !rows.some((pane) =>
                    sameTerminal(pane, panel.target as PaneIdentity),
                  ),
              ),
            }
          : tab,
      ),
    );
  };
  const copyAttach = (pane: PaneView) => {
    void store
      .command({ kind: "open_pane_session", target: identity(pane) })
      .then(async (outcome) => {
        if (!outcome.ok) throw new Error(outcome.error.message);
        if (
          outcome.result.kind !== "attach_session" ||
          !outcome.result.target.attach
        )
          throw new Error("Attach command unavailable");
        const attach = outcome.result.target.attach;
        const quote = (value: string) =>
          `'${value.replaceAll("'", "'\"'\"'")}'`;
        const command = [
          "env",
          ...Object.entries(attach.env).map(
            ([key, value]) => `${key}=${value}`,
          ),
          ...attach.argv,
        ]
          .map(quote)
          .join(" ");
        await navigator.clipboard.writeText(command);
      })
      .catch((error: unknown) => setError(String(error)));
  };
  const choose = (pane: PaneView, _inNewTab = false) => {
    if (!pane.dead && !pane.unavailable) openGroup([pane], pane.sessionName);
  };
  useEffect(() => {
    if (unavailable || connection !== "connected") return;
    if (!initialized.current) {
      initialized.current = true;
      const first = spaces(panes)[0];
      if (first) {
        const next = spaceTabs(panes.filter((p) => spaceKey(p) === first.key));
        setOpenSpace(first.key);
        setTabs(next);
        setActive(next[0]?.id ?? "");
        setFocused(next[0]?.panels[0]?.id ?? "");
      }
      return;
    }
    if (!openSpace) return;
    if (!panes.some((p) => spaceKey(p) === openSpace)) setOpenSpace(null);
    // Refresh native names/order/layout without replacing stable terminal mounts. A hidden
    // viewer stays hidden until explicit selection; newly discovered panes join their window.
    setTabs((previous) => {
      const next = spaceTabs(
        panes.filter((p) => spaceKey(p) === openSpace),
        previous,
      ).map((tab) => ({
        ...tab,
        panels: tab.panels.filter(
          (panel) =>
            !hiddenPanes.current.has(
              JSON.stringify([
                panel.target?.hostGeneration,
                panel.target?.paneId,
              ]),
            ),
        ),
      }));
      return JSON.stringify(next) === JSON.stringify(previous)
        ? previous
        : next;
    });
  }, [panes, unavailable, connection, openSpace]);
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
  const close = (id: string) => {
    const panel = tabs.flatMap((t) => t.panels).find((p) => p.id === id);
    if (panel?.target)
      hiddenPanes.current.add(
        JSON.stringify([panel.target.hostGeneration, panel.target.paneId]),
      );
    setZoom(null);
    setTabs((ts) =>
      ts.map((t) => ({ ...t, panels: t.panels.filter((p) => p.id !== id) })),
    );
  };
  /** Closing is killing: the pane's process ends on the host, then its viewer goes. */
  const killPanel = (id: string) => {
    const panel = tabs.flatMap((t) => t.panels).find((p) => p.id === id);
    if (!panel?.target) return close(id);
    void store
      .command({
        kind: "close_terminal",
        target: {
          hostGeneration: panel.target.hostGeneration,
          sessionName: panel.target.sessionName,
          windowId: panel.target.windowId,
          paneId: panel.target.paneId,
        },
        scope: "pane",
      })
      .then((outcome) => {
        if (outcome.ok) close(id);
        else window.alert(outcome.error.message);
      });
  };
  /** Closing a space kills its whole tmux session; the right panel empties once the host confirms. */
  const closeSpace = () => {
    if (!openSpace) return;
    const rows = store
      .getState()
      .panes.filter(
        (p) => spaceKey(p) === openSpace && !p.dead && !p.unavailable,
      );
    const target = rows[0];
    if (!target) return;
    const count = rows.length;
    if (
      !window.confirm(
        `Close space "${target.sessionName}" and kill ${count} process${count === 1 ? "" : "es"}?`,
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
        scope: "session",
      })
      .then((outcome) => {
        if (!outcome.ok) return window.alert(outcome.error.message);
        setZoom(null);
        setOpenSpace(null);
        setTabs([]);
      });
  };
  const dispatch = (action: Action) => {
    const tab = tabs.find((t) => t.id === active);
    if (action === "commands") {
      setPalette((v) => !v);
      return;
    }
    if (action === "literal") {
      // The prefix chord itself, as the byte a terminal would have received: Ctrl+Space is NUL,
      // Ctrl+<letter> is that control character.
      const chord = parseChord(bindings.config.prefix ?? "");
      const byte =
        chord?.key === " "
          ? "\x00"
          : chord?.ctrlKey && /^[a-z]$/.test(chord.key)
            ? String.fromCharCode(chord.key.charCodeAt(0) - 96)
            : "\x01";
      (
        window.loom.terms?.[focused] as
          | { input(data: string, user?: boolean): void }
          | undefined
      )?.input(byte, true);
      return;
    }
    const numbered = /^(tab|agent|space)-([1-9])$/.exec(action);
    if (numbered) {
      const index = Number(numbered[2]) - 1;
      if (numbered[1] === "tab") {
        const target = tabs[index];
        if (!target) return;
        setActive(target.id);
        setZoom(null);
        keyboardFocus(target.panels[0]?.id ?? "");
        return;
      }
      const state = store.getState();
      const tree = spaces(
        state.panes,
        "",
        state.snapshot.runs,
        false,
        state.readFinished,
      );
      if (numbered[1] === "space") {
        const space = tree[index];
        const rows = space?.tabs[0]?.panes.map((row) => row.pane) ?? [];
        if (space && rows.length) openGroup(rows, space.name);
        return;
      }
      if (index === 0) {
        if (state.ui.repo) openPinned("main");
        return;
      }
      const agent = tree
        .flatMap((space) => space.tabs.flatMap((tab) => tab.panes))
        .filter(
          ({ pane }) =>
            (pane.provider || pane.runId || pane.agent) && !pane.dead,
        )[index - 1];
      if (agent) choose(agent.pane);
      return;
    }
    if (action === "new") return newTab();
    if (action === "new-space") return newSpace();
    if (action === "jump") {
      setPalette(true);
      return;
    }
    if (action === "help") {
      setHelp(true);
      return;
    }
    if (action === "close") return killPanel(focused);
    if (action === "close-space") return closeSpace();
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
    if (!tab) return;
    if (action === "split-right" || action === "split-down") {
      setPendingTab({
        key: crypto.randomUUID(),
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
    const matcher = bindingMatcher(
      bindings.config,
      (action) => latest.current.dispatch(action),
      setPrefixArmed,
    );
    const key = (e: KeyboardEvent) => {
      // The palette chord is never gated: it opens the palette from anywhere and closes it too.
      if (
        e.type === "keydown" &&
        !e.repeat &&
        (bindings.config.bindings.commands ?? [])
          .filter((binding) => !isPrefixBinding(binding))
          .some((binding) => matchesChord(binding, e))
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        matcher.cancel();
        setPalette((v) => !v);
        return;
      }
      if (
        document.querySelector(
          'dialog[open], [aria-modal="true"], [role="menu"]',
        ) ||
        (e.target instanceof Element && e.target.closest(".wb-rename"))
      ) {
        matcher.cancel();
        return;
      }
      if (matcher.handle(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", matcher.cancel);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", matcher.cancel);
      matcher.cancel();
    };
  }, [bindings.config]);
  const scratch = newTab;
  const selectedPanel = tabs
    .find((tab) => tab.id === active)
    ?.panels.find((panel) => panel.id === focused);
  mainSelected.current = !!(
    selectedPanel?.target &&
    mainTarget &&
    sameTerminal(selectedPanel.target, mainTarget.pane)
  );
  return (
    <div className="workbench">
      <div className="wb-titlebar" aria-hidden="true" />
      {pendingTab && (
        <NewTerminalDialog
          kind={pendingTab.space ? "space" : "terminal"}
          initialName={pendingTab.space ? "" : `Terminal ${tabs.length + 1}`}
          create={createTab}
          cancel={() => setPendingTab(null)}
        />
      )}
      <div className="wb-body">
        <Sidebar
          selected={
            selectedPanel?.target &&
            mainTarget?.repo === repo &&
            sameTerminal(selectedPanel.target, mainTarget.pane)
              ? "main"
              : selectedPanel?.target
          }
          selectedSpace={openSpace ?? undefined}
          selectedTab={active}
          collapsed={sidebarCollapsed}
          toggleSidebar={() => setSidebarCollapsed((value) => !value)}
          showMenu={() => setPalette(true)}
          filter={filter}
          setFilter={setFilter}
          choose={choose}
          openGroup={openGroup}
          hidePanels={hidePanels}
          hasPanels={hasPanels}
          copyAttach={copyAttach}
          newTerminal={() => newTab()}
          newSpace={newSpace}
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
                zoom={active === t.id ? zoom : null}
                close={killPanel}
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
        keybindingStatus={
          <>
            {prefixArmed && (
              <span className="wb-keybinding-status" role="status">
                {bindings.config.prefix} armed · waiting for key (
                {bindings.config.prefixTimeoutMs / 1000}s)
              </span>
            )}
            {bindings.error && (
              <span
                className="wb-keybinding-status"
                role="alert"
                title={`${bindings.error}${bindings.path ? ` · ${bindings.path}` : ""}`}
              >
                {bindings.error}
              </span>
            )}
          </>
        }
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
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPalette(false);
          }}
        >
          <div className="palette">
            <Command label="Workbench commands" loop>
              <button type="button" onClick={() => setPalette(false)}>
                Close
              </button>
              <Command.Input autoFocus placeholder="Type a command…" />
              <Command.List>
                <DevControlCommands close={() => setPalette(false)} />
                <ChimeMuteCommand close={() => setPalette(false)} />
                {actions.map((a) => (
                  <Command.Item
                    key={a.id}
                    onSelect={() => {
                      setPalette(false);
                      dispatch(a.id);
                    }}
                  >
                    {a.label} <kbd>{formatBindings(bindings.config, a.id)}</kbd>
                  </Command.Item>
                ))}
                {paletteTree.map((space) => (
                  <Command.Item
                    key={`space:${space.key}`}
                    value={`space ${space.label} ${space.name} ${space.branch ?? ""}`}
                    onSelect={() => {
                      setPalette(false);
                      const rows =
                        space.tabs[0]?.panes.map((r) => r.pane) ?? [];
                      if (rows.length) openGroup(rows, space.name);
                    }}
                  >
                    Open space {space.label} <kbd>{space.branch ?? ""}</kbd>
                  </Command.Item>
                ))}
                {paletteTree
                  .flatMap((space) =>
                    space.tabs.flatMap((tab) =>
                      tab.panes
                        .filter(
                          ({ pane }) =>
                            (pane.provider || pane.runId || pane.agent) &&
                            !pane.dead,
                        )
                        .map((row) => ({ ...row, space, tab })),
                    ),
                  )
                  .map(({ pane, space, tab }) => (
                    <Command.Item
                      key={`agent:${pane.id}`}
                      value={`agent ${space.label} ${tab.name} ${pane.provider ?? pane.agent ?? ""}`}
                      onSelect={() => {
                        setPalette(false);
                        choose(pane);
                      }}
                    >
                      Open agent {space.label} · {tab.name}{" "}
                      <kbd>{pane.provider ?? pane.agent ?? ""}</kbd>
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
                <Command.Item
                  onSelect={() => {
                    setPalette(false);
                    store.setView("settings");
                    void window.loomHost.setMode("tracker");
                  }}
                >
                  Settings
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
                <kbd>{formatBindings(bindings.config, a.id)}</kbd> {a.label}
              </p>
            ))}
            <p>
              Prefix expires after {bindings.config.prefixTimeoutMs / 1000}{" "}
              seconds. Escape cancels. Modifier keys preserve the prefix;
              unknown suffixes pass through.
            </p>
            <p>
              {bindings.path
                ? `Edit ${bindings.path}; changes reload automatically.`
                : "Using default keybindings."}
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
