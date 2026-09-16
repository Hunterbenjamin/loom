import { type KeybindingAction, parseChord } from "@loom/core";
import type { PaneView } from "@loom/protocol";
import type { Dispatch, SetStateAction } from "react";
import type { KeybindingsState } from "../../shared/keybindings.js";
import type { useStoreApi } from "../store/react.js";
import { enterFocusedScrollMode } from "../ui/terminal.js";
import { spaces } from "./selectors.js";
import type { Panel, Tab } from "./tabs.js";

export type PendingTab = {
  key: string;
  space?: boolean;
  split?: { tabId: string; panelId: string; direction: "right" | "below" };
};

type Store = ReturnType<typeof useStoreApi>;

type DispatchOptions = {
  tabs: Tab[];
  active: string;
  focused: string;
  bindings: KeybindingsState;
  store: Store;
  setPalette: Dispatch<SetStateAction<boolean>>;
  setZoom: Dispatch<SetStateAction<string | null>>;
  setPendingTab: Dispatch<SetStateAction<PendingTab | null>>;
  selectTab: (tab: Tab) => void;
  keyboardFocus: (id: string) => void;
  openGroup: (rows: PaneView[], name: string) => void;
  openPinned: (system: "main") => void;
  choose: (pane: PaneView) => void;
  killPanel: (id: string) => void;
  closeSpace: () => void;
  newTab: () => void;
  newSpace: () => void;
};

export const workbenchDispatch = (options: DispatchOptions) =>
  function dispatch(action: KeybindingAction) {
    const {
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
    } = options;
    const tab = tabs.find((candidate) => candidate.id === active);
    if (action === "commands") return setPalette((value) => !value);
    if (action === "scroll-mode") return enterFocusedScrollMode();
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
        if (target) selectTab(target);
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
        const target = tree[index];
        const rows = target?.tabs[0]?.panes.map((row) => row.pane) ?? [];
        if (target && rows.length) openGroup(rows, target.name);
        return;
      }
      if (index === 0) {
        if (state.ui.repo) openPinned("main");
        return;
      }
      const agent = tree
        .flatMap((space) => space.tabs.flatMap((item) => item.panes))
        .filter(
          ({ pane }) =>
            (pane.provider || pane.runId || pane.agent) && !pane.dead,
        )[index - 1];
      if (agent) choose(agent.pane);
      return;
    }
    if (action === "new") return newTab();
    if (action === "new-space") return newSpace();
    if (action === "jump") return setPalette(true);
    if (action === "close") return killPanel(focused);
    if (action === "close-space") return closeSpace();
    if (action === "zoom") return setZoom((value) => (value ? null : focused));
    if (action === "next" || action === "previous") {
      const index = tabs.findIndex((candidate) => candidate.id === active);
      const target =
        tabs[(index + (action === "next" ? 1 : tabs.length - 1)) % tabs.length];
      if (target) selectTab(target);
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
      .filter((panel) => panel.id !== focused)
      .map((panel) => ({
        p: panel,
        r: document
          .querySelector(`[data-panel="${panel.id}"]`)
          ?.getBoundingClientRect(),
      }))
      .filter((value): value is { p: Panel; r: DOMRect } => !!value.r)
      .map((value) => ({
        ...value,
        dx: (value.r.left + value.r.right - current.left - current.right) / 2,
        dy: (value.r.top + value.r.bottom - current.top - current.bottom) / 2,
      }))
      .filter((value) =>
        action === "left"
          ? value.dx < -1
          : action === "right"
            ? value.dx > 1
            : action === "up"
              ? value.dy < -1
              : value.dy > 1,
      )
      .sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
    if (candidates[0]) keyboardFocus(candidates[0].p.id);
  };
