import type { PaneView } from "@loom/protocol";
import { useState } from "react";
import { useStore } from "../store/react.js";
import { LeadBar } from "../ui/lead.js";
import {
  useWindowKeybindings,
  useWorkbenchKeybindings,
} from "../window-keybindings.js";
import { NewTerminalDialog } from "./new-terminal.js";
import { WorkbenchPalette } from "./palette.js";
import { attentionPanes, sameTerminal, spaceKey } from "./selectors.js";
import { Sidebar } from "./sidebar.js";
import { TabGrid } from "./tab-grid.js";
import { createdTerminal, identity } from "./tabs.js";
import { useChatTerminal } from "./use-chat-terminal.js";
import { useMainSession } from "./use-main-session.js";
import {
  useSpaceTabs,
  useSpaceTabsInventory,
  useSpaceTabsMarkRead,
  useSpaceTabsRepair,
} from "./use-space-tabs.js";
import { type PendingTab, workbenchDispatch } from "./workbench-dispatch.js";
import "./workbench.css";

export function Workbench() {
  const spaceTabsState = useSpaceTabs();
  const {
    store,
    panes,
    tabs,
    openSpace,
    active,
    focused,
    zoom,
    setZoom,
    focus,
    keyboardFocus,
    selectTab,
    openGroup,
    hidePanels,
    killPanel,
    closeSpace,
  } = spaceTabsState;
  const repo = useStore((state) => state.ui.repo);
  const [filter, setFilter] = useState("");
  const [palette, setPalette] = useState(false);
  const [error, setError] = useState("");
  const { bindings, prefixArmed } = useWindowKeybindings();
  const [pendingTab, setPendingTab] = useState<PendingTab | null>(null);

  useSpaceTabsMarkRead(spaceTabsState);
  const newTab = () => setPendingTab({ key: crypto.randomUUID() });
  const newSpace = () =>
    setPendingTab({ key: crypto.randomUUID(), space: true });
  const createTab = async (name: string) => {
    if (!pendingTab) return;
    const split = pendingTab.split;
    const target = split
      ? tabs
          .find((tab) => tab.id === split.tabId)
          ?.panels.find((panel) => panel.id === split.panelId)?.target
      : panes.find(
          (pane) =>
            spaceKey(pane) === openSpace && !pane.dead && !pane.unavailable,
        );
    if (pendingTab.space) {
      const result = await store.command({
        kind: "open_workbench_terminal",
        key: pendingTab.key,
        label: "shell",
        workspace: name,
      });
      if (!result.ok) throw new Error(result.error.message);
      const ref = createdTerminal(result.result);
      const created = ref
        ? store.getState().panes.find((pane) => sameTerminal(pane, ref))
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
    const ref = createdTerminal(result.result);
    const created = ref
      ? store.getState().panes.find((pane) => sameTerminal(pane, ref))
      : undefined;
    if (!created)
      throw new Error("Terminal creation was not confirmed in inventory");
    openGroup([created], created.sessionName);
    setPendingTab(null);
  };

  const selectedPanel = tabs
    .find((tab) => tab.id === active)
    ?.panels.find((panel) => panel.id === focused);
  const { mainTarget, openPinned } = useMainSession({
    store,
    repo,
    selectedPanel,
    openGroup,
    onError: setError,
  });
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
      .catch((caught: unknown) => setError(String(caught)));
  };
  const choose = (pane: PaneView, _inNewTab = false) => {
    if (!pane.dead && !pane.unavailable) openGroup([pane], pane.sessionName);
  };
  useChatTerminal({ store, openMain: () => openPinned("main"), choose });
  useSpaceTabsInventory(spaceTabsState);
  useSpaceTabsRepair(spaceTabsState);

  const dispatch = workbenchDispatch({
    tabs,
    active,
    focused,
    bindings,
    store,
    setPalette,
    setZoom,
    setPendingTab,
    selectTab,
    keyboardFocus,
    openGroup,
    openPinned,
    choose,
    killPanel,
    closeSpace,
    newTab,
    newSpace,
  });
  useWorkbenchKeybindings(dispatch);

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
          filter={filter}
          choose={choose}
          openGroup={openGroup}
          hidePanels={hidePanels}
          copyAttach={copyAttach}
          openPinned={openPinned}
        />
        <main className="wb-main">
          <nav className="wb-tabs" aria-label="Workbench tabs">
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                aria-pressed={active === tab.id}
                onClick={() => selectTab(tab)}
              >
                {tab.name}
              </button>
            ))}
            <button type="button" onClick={newTab}>
              ＋
            </button>
          </nav>
          <div className="wb-layout">
            {tabs.map((tab) => (
              <TabGrid
                key={tab.id}
                tab={tab}
                active={active === tab.id}
                focused={focused}
                focus={focus}
                zoom={active === tab.id ? zoom : null}
                close={killPanel}
              />
            ))}
            {!tabs.length && (
              <button type="button" onClick={newTab}>
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
        surface="workbench"
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
        <WorkbenchPalette
          close={() => setPalette(false)}
          dispatch={dispatch}
          openGroup={openGroup}
          choose={choose}
          scratch={newTab}
          bindings={bindings}
        />
      )}
    </div>
  );
}
