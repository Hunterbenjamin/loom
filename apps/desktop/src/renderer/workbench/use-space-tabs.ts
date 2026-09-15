import type { PaneIdentity, PaneView } from "@loom/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore, useStoreApi } from "../store/react.js";
import { sameTerminal, spaceKey, spaces, tabKey } from "./selectors.js";
import { spaceTabs, type Tab } from "./tabs.js";

export const useSpaceTabs = () => {
  const store = useStoreApi();
  const panes = useStore((state) => state.panes);
  const unavailable = useStore((state) => state.panesUnavailable);
  const connection = useStore((state) => state.connection);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const initialized = useRef(false);
  const hiddenPanes = useRef(new Set<string>());
  const [openSpace, setOpenSpace] = useState<string | null>(null);
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const [focused, setFocused] = useState(tabs[0]?.panels[0]?.id ?? "");

  useLayoutEffect(
    () =>
      store.registerPaneFocus(() => {
        const panel = tabs
          .find((tab) => tab.id === active)
          ?.panels.find((candidate) => candidate.id === focused);
        return panel?.target;
      }),
    [store, tabs, active, focused],
  );

  const [zoom, setZoom] = useState<string | null>(null);
  const focus = useCallback((id: string) => setFocused(id), []);
  const keyboardFocus = useCallback((id: string) => {
    setFocused(id);
    requestAnimationFrame(() =>
      (window.loom.terms?.[id] as { focus(): void } | undefined)?.focus(),
    );
  }, []);
  const selectTab = (tab: Tab) => {
    setActive(tab.id);
    setZoom(null);
    keyboardFocus(tab.panels[0]?.id ?? "");
  };
  const openGroup = (rows: PaneView[], _name: string) => {
    if (store.getState().panesUnavailable || !rows[0]) return;
    hiddenPanes.current.clear();
    const key = spaceKey(rows[0]);
    const inventory = store
      .getState()
      .panes.filter((pane) => spaceKey(pane) === key);
    store.markPanesRead(rows);
    const next = spaceTabs(inventory, openSpace === key ? tabs : []);
    const selected =
      next.find((tab) => tab.id === tabKey(rows[0] as PaneView)) ?? next[0];
    if (!selected) return;
    setOpenSpace(key);
    setTabs(next);
    setActive(selected.id);
    setZoom(null);
    keyboardFocus(
      selected.panels.find(
        (panel) =>
          panel.target && sameTerminal(panel.target, rows[0] as PaneView),
      )?.id ??
        selected.panels[0]?.id ??
        "",
    );
  };
  const hidePanels = (rows: PaneView[]) => {
    for (const pane of rows) hiddenPanes.current.add(pane.id);
    // This menu closes viewers only, including human shells. Other tabs keep their clients.
    setZoom(null);
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
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
  const close = (id: string) => {
    const panel = tabs
      .flatMap((tab) => tab.panels)
      .find((candidate) => candidate.id === id);
    if (panel?.target)
      hiddenPanes.current.add(
        JSON.stringify([panel.target.hostGeneration, panel.target.paneId]),
      );
    setZoom(null);
    setTabs((currentTabs) =>
      currentTabs.map((tab) => ({
        ...tab,
        panels: tab.panels.filter((candidate) => candidate.id !== id),
      })),
    );
  };
  /** Closing is killing: the pane's process ends on the host, then its viewer goes. */
  const killPanel = (id: string) => {
    const panel = tabs
      .flatMap((tab) => tab.panels)
      .find((candidate) => candidate.id === id);
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
        (pane) =>
          spaceKey(pane) === openSpace && !pane.dead && !pane.unavailable,
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

  return {
    store,
    panes,
    unavailable,
    connection,
    tabs,
    initialized,
    hiddenPanes,
    openSpace,
    active,
    focused,
    zoom,
    setTabs,
    setOpenSpace,
    setActive,
    setFocused,
    setZoom,
    focus,
    keyboardFocus,
    selectTab,
    openGroup,
    hidePanels,
    close,
    killPanel,
    closeSpace,
  };
};

export type SpaceTabs = ReturnType<typeof useSpaceTabs>;

/** Called separately so Workbench preserves the original cross-concern effect order. */
export const useSpaceTabsMarkRead = ({ store, tabs, focused }: SpaceTabs) => {
  useEffect(() => {
    const panel = tabs
      .flatMap((tab) => tab.panels)
      .find((candidate) => candidate.id === focused);
    if (panel?.target) store.markPanesRead([panel.target]);
    if (panel?.target?.sessionName === `loom-lead-${store.getState().ui.repo}`)
      store.markMainRead();
  }, [focused, tabs, store]);
};

export const useSpaceTabsInventory = (spaceTabsState: SpaceTabs) => {
  const {
    panes,
    unavailable,
    connection,
    openSpace,
    initialized,
    hiddenPanes,
    setOpenSpace,
    setTabs,
    setActive,
    setFocused,
  } = spaceTabsState;
  // These refs deliberately do not retrigger inventory reconciliation; they only retain
  // initialization and explicit viewer-hide state across inventory updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable mutable inputs
  useEffect(() => {
    if (unavailable || connection !== "connected") return;
    if (!initialized.current) {
      initialized.current = true;
      const first = spaces(panes)[0];
      if (first) {
        const next = spaceTabs(
          panes.filter((pane) => spaceKey(pane) === first.key),
        );
        setOpenSpace(first.key);
        setTabs(next);
        setActive(next[0]?.id ?? "");
        setFocused(next[0]?.panels[0]?.id ?? "");
      }
      return;
    }
    if (!openSpace) return;
    if (!panes.some((pane) => spaceKey(pane) === openSpace)) setOpenSpace(null);
    // Refresh native names/order/layout without replacing stable terminal mounts. A hidden
    // viewer stays hidden until explicit selection; newly discovered panes join their window.
    setTabs((previous: Tab[]) => {
      const next = spaceTabs(
        panes.filter((pane) => spaceKey(pane) === openSpace),
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
};

export const useSpaceTabsRepair = ({
  tabs,
  active,
  focused,
  setActive,
  setZoom,
  keyboardFocus,
}: SpaceTabs) => {
  useEffect(() => {
    const tab = tabs.find((candidate) => candidate.id === active) ?? tabs[0];
    if (
      tab &&
      (!tabs.some((candidate) => candidate.id === active) ||
        !tab.panels.some((panel) => panel.id === focused))
    ) {
      setActive(tab.id);
      keyboardFocus(tab.panels[0]?.id ?? "");
      setZoom(null);
    }
  }, [tabs, active, focused, keyboardFocus, setActive, setZoom]);
};
