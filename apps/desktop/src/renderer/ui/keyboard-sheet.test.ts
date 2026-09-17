// @vitest-environment happy-dom
import { KEYBINDING_ACTIONS } from "@loom/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { defaultKeybindingsState } from "../../shared/keybindings.js";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider, useStoreApi } from "../store/react.js";
import {
  useWindowKeybindings,
  useWorkbenchKeybindings,
  WindowKeybindings,
} from "../window-keybindings.js";
import { WindowModeContext } from "../window-mode.js";
import { KeyboardSheet, WindowKeyboardSheet } from "./keyboard-sheet.js";
import { useShortcuts } from "./keys.js";
import { scrollBindings } from "./scroll-keys.js";
import { trackerKeymap } from "./tracker-keymap.js";

// These tests exercise window shortcuts, not WebGL or terminal rendering.
vi.mock("./terminal.js", () => ({
  enterFocusedScrollMode: vi.fn(),
  TerminalTab: () => null,
  TaskShellTerminal: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  document.body.innerHTML = "";
});

function mount() {
  const previous = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(previous, host);
  previous.focus();
  const root = createRoot(host);
  cleanups.push(() => root.unmount());
  return { root, host, previous };
}
function press(
  target: Element,
  key: string,
  modifiers: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

test("one modal contains every source entry once, with effective bindings and scoped reading keys", () => {
  const { root, host } = mount();
  const bindings = structuredClone(defaultKeybindingsState);
  bindings.config.bindings.new = ["Cmd+U"];
  bindings.config.prefixTimeoutMs = 4200;
  bindings.path = "/fixture/keybindings.json";
  bindings.error = "Invalid configuration";
  act(() =>
    root.render(createElement(KeyboardSheet, { bindings, onClose: vi.fn() })),
  );
  const dialog = host.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  expect(dialog?.getAttribute("aria-labelledby")).toBe("keyboard-sheet-title");
  for (const entry of trackerKeymap)
    expect(host.querySelectorAll(`[data-key-id="${entry.id}"]`)).toHaveLength(
      1,
    );
  for (const entry of KEYBINDING_ACTIONS)
    expect(
      host.querySelectorAll(`[data-action-id="${entry.id}"]`),
    ).toHaveLength(1);
  for (const entry of scrollBindings)
    expect(
      host
        .querySelector(`[data-key-id="${entry.id}"]`)
        ?.closest('[role="tabpanel"]')?.id,
    ).toBe("keyboard-panel-0");
  for (const id of [
    "expand-item",
    "collapse-section",
    "next-section",
    "previous-section",
  ]) {
    expect(
      host
        .querySelector(`[data-key-id="${id}"]`)
        ?.closest("section")
        ?.querySelector("h3")?.textContent,
    ).toBe("Sections");
  }
  expect(host.textContent).toContain("Cmd+U");
  expect(host.textContent).toContain("4.2 seconds");
  expect(host.textContent).toContain(bindings.path);
  expect(host.textContent).toContain("Escape cancels");
  expect(host.textContent).toContain("unknown suffixes pass through");
  expect(host.textContent).toContain("fixed in code");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    bindings.error,
  );
});

test("tabs, reading keys, cancel and Close are keyboard accessible and restore focus", () => {
  const { root, host, previous } = mount();
  const close = vi.fn(() => root.render(null));
  const render = () =>
    act(() =>
      root.render(
        createElement(KeyboardSheet, {
          bindings: defaultKeybindingsState,
          onClose: close,
        }),
      ),
    );
  render();
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(document.activeElement).toBe(tabs[0]);
  for (const [key, index] of [
    ["ArrowRight", 1],
    ["l", 2],
    ["ArrowLeft", 1],
    ["h", 0],
  ] as const) {
    press(document.activeElement!, key);
    expect(document.activeElement).toBe(tabs[index]);
    expect(tabs[index]?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
  }
  const panel = host.querySelector<HTMLDivElement>('[role="tabpanel"]')!;
  Object.defineProperty(panel, "clientHeight", { value: 400 });
  Object.defineProperty(panel, "scrollHeight", { value: 2000 });
  press(tabs[0]!, "j");
  expect(panel.scrollTop).toBe(40);
  press(tabs[0]!, "d", { ctrlKey: true });
  expect(panel.scrollTop).toBe(240);
  press(tabs[0]!, "G", { shiftKey: true });
  expect(panel.scrollTop).toBe(2000);
  press(tabs[0]!, "g");
  press(tabs[0]!, "g");
  expect(panel.scrollTop).toBe(0);
  panel.focus();
  press(panel, " ");
  expect(panel.scrollTop).toBe(400);
  expect(press(panel, "Tab").defaultPrevented).toBe(false);
  const closeButton = host.querySelector<HTMLButtonElement>(
    ".keyboard-sheet-close",
  )!;
  expect(closeButton.tabIndex).toBe(0);
  expect(press(closeButton, " ").defaultPrevented).toBe(false);
  act(() =>
    host
      .querySelector("dialog")
      ?.dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(previous);
  render();
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(
    "Everywhere",
  );
  act(() =>
    host.querySelector<HTMLButtonElement>(".keyboard-sheet-close")?.click(),
  );
  expect(document.activeElement).toBe(previous);
});

function TrackerOpener() {
  const { showHelp } = useWindowKeybindings();
  const store = useStoreApi();
  useShortcuts(store, showHelp);
  return createElement("button", { type: "button", onClick: showHelp }, "Open");
}

test.each(["tracker", "workbench"] as const)(
  "window-level help opens on Everywhere in %s and blocks underlying shortcuts",
  async (mode) => {
    const { root, host } = mount();
    window.loomHost = {
      keybindings: async () => defaultKeybindingsState,
      onKeybindingsChanged: () => () => {},
    } as unknown as typeof window.loomHost;
    const store = createFixtureStore(buildSnapshot(2));
    await act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: Typed provider requires children.
          children: createElement(
            WindowModeContext,
            { value: mode },
            createElement(
              WindowKeybindings,
              { mode },
              mode === "tracker"
                ? createElement(TrackerOpener)
                : createElement(
                    "button",
                    { type: "button" },
                    "Terminal surface",
                  ),
              createElement(WindowKeyboardSheet),
            ),
          ),
        }),
      ),
    );
    const opener = host.querySelector("button")!;
    opener.focus();
    for (const entry of mode === "tracker" ? ["plain", "prefix"] : ["prefix"]) {
      if (entry === "prefix") press(opener, " ", { ctrlKey: true });
      press(opener, "?", { shiftKey: true });
      expect(host.querySelector("dialog")?.open).toBe(true);
      expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(
        "Everywhere",
      );
      const tab = host.querySelector('[role="tab"]')!;
      // The palette exception must not intercept this chord while a dialog owns focus.
      expect(press(tab, "k", { metaKey: true }).defaultPrevented).toBe(false);
      press(tab, "c");
      expect(store.getState().ui.createPalette).toBe(false);
      expect(store.getState().ui.create).toBeNull();
      press(tab, "l");
      press(document.activeElement!, "Escape");
      expect(host.querySelector("dialog")).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  },
);

function WorkbenchDispatcher({
  dispatch,
}: {
  dispatch: (action: string) => void;
}) {
  useWorkbenchKeybindings(dispatch);
  return createElement("button", { type: "button" }, "Terminal surface");
}

test("the palette chord opens the palette of the window on screen, and Workbench chords stay in the Workbench", async () => {
  window.loomHost = {
    keybindings: async () => defaultKeybindingsState,
    onKeybindingsChanged: () => () => {},
  } as unknown as typeof window.loomHost;
  for (const mode of ["tracker", "workbench"] as const) {
    const { root, host } = mount();
    const store = createFixtureStore(buildSnapshot(2));
    const dispatch = vi.fn();
    // Both surfaces stay mounted in one window; only the mode on screen may act.
    await act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: Typed provider requires children.
          children: createElement(
            WindowModeContext,
            { value: mode },
            createElement(
              WindowKeybindings,
              { mode },
              createElement(TrackerOpener),
              createElement(WorkbenchDispatcher, { dispatch }),
            ),
          ),
        }),
      ),
    );
    const surface = host.querySelector("button")!;
    surface.focus();
    expect(press(surface, "k", { metaKey: true }).defaultPrevented).toBe(true);
    if (mode === "tracker") {
      expect(store.getState().ui.palette).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      press(surface, "k", { metaKey: true });
      expect(store.getState().ui.palette).toBe(false);
      // Ctrl+K is not the configured chord: it no longer opens anything.
      press(surface, "k", { ctrlKey: true });
      expect(store.getState().ui.palette).toBe(false);
      press(surface, "t", { metaKey: true });
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(dispatch).toHaveBeenCalledWith("commands");
      expect(store.getState().ui.palette).toBe(false);
      press(surface, "t", { metaKey: true });
      expect(dispatch).toHaveBeenLastCalledWith("new");
    }
    act(() => root.unmount());
  }
});
