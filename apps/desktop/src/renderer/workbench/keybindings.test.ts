// @vitest-environment happy-dom
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { meta } from "../../../../../packages/protocol/src/test-support.js";
import {
  defaultKeybindings,
  type KeybindingsState,
} from "../../shared/keybindings.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { WindowKeyboardSheet } from "../ui/keyboard-sheet.js";
import { WindowKeybindings } from "../window-keybindings.js";
import { Workbench } from "./workbench.js";

// Keep the real TerminalSession and its custom key handler. Model xterm's
// textarea capture listener, including a downstream terminal-input observer.
const terminalKeys = vi.hoisted(() => vi.fn());
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 100;
    rows = 24;
    unicode = { activeVersion: "" };
    textarea = document.createElement("textarea");
    handler = (_event: KeyboardEvent) => true;
    data = (_data: string) => {};
    loadAddon() {}
    open(host: HTMLElement) {
      host.append(this.textarea);
      this.textarea.addEventListener(
        "keydown",
        (event) => {
          terminalKeys(event.key);
          if (this.handler(event) && event.key.length === 1)
            this.data(event.key);
        },
        true,
      );
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.handler = handler;
    }
    onData(fn: (data: string) => void) {
      this.data = fn;
    }
    input(data: string) {
      this.data(data);
    }
    buffer = { active: { type: "normal", viewportY: 0, baseY: 100 } };
    scrollToBottom() {}
    onResize() {}
    onScroll() {}
    write() {}
    focus() {
      this.textarea.focus();
    }
    dispose() {
      this.textarea.remove();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-unicode-graphemes", () => ({
  UnicodeGraphemesAddon: class {},
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("dockview", () => ({
  GridviewReact: () => null,
  Orientation: { HORIZONTAL: "horizontal" },
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function harness(panes = [pane]) {
  const store = createStore(undefined, "test");
  store.applyProtocol(
    stateFromSnapshot(meta, { ...emptySnapshotBody(), panes }),
  );
  store.setConnection("connected");
  let changed: (state: KeybindingsState) => void = () => {};
  const unsubscribe = vi.fn();
  window.loomHost = {
    setMode: vi.fn(async () => {}),
    chooseRepository: vi.fn(),
    interactive: vi.fn(),
    keybindings: async () => ({
      config: defaultKeybindings,
      path: "/fixture/dev/keybindings.json",
      error: null,
    }),
    onKeybindingsChanged: (fn: (state: KeybindingsState) => void) => {
      changed = fn;
      return unsubscribe;
    },
  } as unknown as typeof window.loomHost;
  window.loomTerminal = {
    paneFlags: vi.fn(async () => ({ alternate: false })),
    spawn: vi.fn(async () => ({ pid: 1, command: "fake attach" })),
    kill: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    off: vi.fn(),
  };
  window.loom = { store, ready: true, term: null };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: Typed provider requires children.
        children: createElement(
          WindowKeybindings,
          { mode: "workbench" },
          createElement(Workbench),
          createElement(WindowKeyboardSheet),
        ),
      }),
    ),
  );
  const terminal = element.querySelector("textarea");
  if (!terminal) throw new Error("Terminal did not mount");
  const press = async (
    target: Element,
    key: string,
    modifiers: KeyboardEventInit = {},
  ) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  };
  return {
    element,
    store,
    terminal,
    press,
    unsubscribe,
    async push(state: KeybindingsState) {
      await act(async () => changed(state));
    },
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

test("a chord with xterm focused opens New Tab once before xterm or kitty can send input", async () => {
  const h = await harness();
  try {
    h.terminal.focus();
    expect(document.activeElement).toBe(h.terminal);
    terminalKeys.mockClear();
    const event = await h.press(h.terminal, "t", { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(h.element.querySelectorAll("dialog")).toHaveLength(1);
    expect(terminalKeys).not.toHaveBeenCalled();
    expect(window.loomTerminal.write).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

test("prefix survives Shift on every focus surface; literal, plain typing and kitty input remain intact", async () => {
  const h = await harness();
  try {
    const surfaces = [
      h.terminal,
      h.element.querySelector(".wb-tabs button"),
      h.element.querySelector("[data-panel] header button"),
    ];
    for (const surface of surfaces) {
      if (!(surface instanceof HTMLElement))
        throw new Error("Missing focus surface");
      surface.focus();
      await h.press(surface, " ", { ctrlKey: true });
      expect(h.element.querySelector(".bottom-bar")?.textContent).toContain(
        "Ctrl+Space armed",
      );
      await h.press(surface, "Shift", { shiftKey: true });
      expect(h.element.querySelector(".bottom-bar")?.textContent).toContain(
        "Ctrl+Space armed",
      );
      await h.press(surface, "?", { shiftKey: true });
      expect(h.element.querySelector(".keyboard-sheet")?.textContent).toContain(
        "Cmd+D / Ctrl+Space then |",
      );
      expect(h.element.querySelector(".bottom-bar")?.textContent).not.toContain(
        "armed",
      );
      await act(async () =>
        h.element
          .querySelector<HTMLButtonElement>(".keyboard-sheet-close")
          ?.click(),
      );
    }
    h.terminal.focus();
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, "Control", { ctrlKey: true });
    await h.press(h.terminal, " ", { ctrlKey: true });
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      "\x00",
    );
    await h.press(h.terminal, "b");
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      "b",
    );
    await h.press(h.terminal, "Enter", { shiftKey: true });
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      "\x1b[13;2u",
    );
    vi.mocked(window.loomTerminal.write).mockClear();
    await h.press(h.terminal, "Enter", { metaKey: true, shiftKey: true });
    expect(window.loomTerminal.write).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test("live reload changes help and matching together, disarms the old prefix, and reports invalid config in the bottom bar", async () => {
  const h = await harness();
  try {
    await h.press(h.terminal, " ", { ctrlKey: true });
    const config = structuredClone(defaultKeybindings);
    config.bindings.help = ["Ctrl+Shift+H"];
    config.bindings.new = ["Cmd+U"];
    config.prefixTimeoutMs = 4200;
    await h.push({
      config,
      path: "/fixture/dev/keybindings.json",
      error: null,
    });
    expect(h.element.querySelector(".bottom-bar")?.textContent).not.toContain(
      "armed",
    );
    const old = await h.press(h.terminal, "t", { metaKey: true });
    expect(old.defaultPrevented).toBe(false);
    await h.press(h.terminal, "H", { ctrlKey: true, shiftKey: true });
    const help = h.element.querySelector(".keyboard-sheet");
    expect(help?.textContent).toContain("Ctrl+Shift+H");
    expect(help?.textContent).toContain("Cmd+U");
    expect(help?.textContent).toContain("4.2 seconds");
    expect(help?.textContent).not.toContain("Ctrl+Space then ?");
    await h.push({
      config: defaultKeybindings,
      path: "/fixture/dev/keybindings.json",
      error: "Invalid keybindings.json; using defaults",
    });
    expect(
      h.element.querySelector(".bottom-bar [role=alert]")?.textContent,
    ).toContain("Invalid keybindings.json");
    expect(help?.textContent).toContain("Cmd+T");
  } finally {
    await h.close();
  }
});

test("Prefix [ enters the focused terminal's scroll mode and can be rebound", async () => {
  const h = await harness();
  try {
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, "[");
    expect(h.element.querySelector(".terminal-bar")?.textContent).toContain(
      "SCROLL",
    );
    await h.press(h.terminal, "x");
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      "x",
    );
    await h.press(h.terminal, "q");
    expect(h.element.querySelector(".terminal-bar")?.textContent).not.toContain(
      "SCROLL",
    );
    const config = structuredClone(defaultKeybindings);
    config.bindings["scroll-mode"] = ["Ctrl+Shift+S"];
    await h.push({ config, path: "/fixture/keybindings.json", error: null });
    await h.press(h.terminal, "S", { ctrlKey: true, shiftKey: true });
    expect(h.element.querySelector(".terminal-bar")?.textContent).toContain(
      "SCROLL",
    );
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, "?", { shiftKey: true });
    expect(h.element.querySelector(".keyboard-sheet")?.textContent).toContain(
      "Ctrl+Shift+S",
    );
    expect(h.element.querySelector(".keyboard-sheet")?.textContent).toContain(
      "Scroll terminal history",
    );
  } finally {
    await h.close();
  }
});

test("reading follows terminal focus, including Prefix h/l, and retains recency on a header", async () => {
  const h = await harness([pane, { ...pane, id: "second", paneId: "%3" }]);
  try {
    const panels = [...h.element.querySelectorAll<HTMLElement>("[data-panel]")];
    expect(panels).toHaveLength(2);
    for (const [index, panel] of panels.entries())
      panel.getBoundingClientRect = () =>
        ({
          left: index * 100,
          right: (index + 1) * 100,
          top: 0,
          bottom: 100,
        }) as DOMRect;
    const first = panels[0]?.querySelector("textarea");
    const second = panels[1]?.querySelector("textarea");
    if (!first || !second) throw new Error("Missing split terminals");
    await act(async () => first.focus());
    const read = async (target: Element) => {
      await h.press(target, " ", { ctrlKey: true });
      await h.press(target, "[");
    };
    await read(first);
    expect(panels[0]?.textContent).toContain("SCROLL");
    await h.press(first, "q");
    for (const [key, target, panel] of [
      ["l", second, panels[1]],
      ["h", first, panels[0]],
    ] as const) {
      const active = document.activeElement;
      if (!active) throw new Error("Missing keyboard focus");
      await h.press(active, " ", { ctrlKey: true });
      await h.press(active, key);
      await act(
        async () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      expect(document.activeElement).toBe(target);
      await read(target);
      expect(panel?.textContent).toContain("SCROLL");
      await h.press(target, "q");
    }
    await act(async () => second.focus());
    const header = panels[0]?.querySelector("button");
    if (!header) throw new Error("Missing panel header");
    await act(async () => header.focus());
    await read(header);
    expect(panels[1]?.textContent).toContain("SCROLL");
    expect(panels[0]?.textContent).not.toContain("SCROLL");
    expect(window.loomTerminal.write).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test("leaving Workbench terminal input returns to Tracker without sending keys and can be rebound", async () => {
  const h = await harness();
  try {
    h.terminal.focus();
    terminalKeys.mockClear();
    await h.press(h.terminal, " ", { ctrlKey: true });
    expect((await h.press(h.terminal, "q")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(window.loomHost.setMode).toHaveBeenCalledWith("tracker");
    expect(terminalKeys).not.toHaveBeenCalled();
    expect(window.loomTerminal.write).not.toHaveBeenCalled();

    const config = structuredClone(defaultKeybindings);
    config.bindings["terminal-focus"] = ["Prefix e"];
    await h.push({ config, path: "/fixture/keybindings.json", error: null });
    h.terminal.focus();
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, "q");
    expect(document.activeElement).toBe(h.terminal);
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, "e");
    expect(document.activeElement).toBe(document.body);
    expect(window.loomHost.setMode).toHaveBeenCalledTimes(2);
    expect(window.loomTerminal.write).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test("go-to chords return from Workbench, while Tracker sequences remain terminal input", async () => {
  const h = await harness();
  try {
    const config = structuredClone(defaultKeybindings);
    config.bindings["go-research"] = ["g r", "Cmd+R", "Prefix r"];
    config.prefixTimeoutMs = null;
    await h.push({ config, path: null, error: null });
    h.terminal.focus();
    expect((await h.press(h.terminal, "g")).defaultPrevented).toBe(false);
    expect((await h.press(h.terminal, "r")).defaultPrevented).toBe(false);
    expect(window.loomHost.setMode).not.toHaveBeenCalled();
    for (const prefixed of [false, true]) {
      terminalKeys.mockClear();
      vi.mocked(window.loomTerminal.write).mockClear();
      if (prefixed) await h.press(h.terminal, " ", { ctrlKey: true });
      await h.press(h.terminal, "r", { metaKey: !prefixed });
      expect(h.store.getState().ui.view).toBe("research");
      expect(window.loomHost.setMode).toHaveBeenCalledWith("tracker");
      expect(terminalKeys).not.toHaveBeenCalled();
      expect(window.loomTerminal.write).not.toHaveBeenCalled();
    }
  } finally {
    await h.close();
  }
});

test("an indefinite prefix is canceled on window blur and repeats send literal input", async () => {
  const h = await harness();
  try {
    const config = structuredClone(defaultKeybindings);
    config.prefixTimeoutMs = null;
    await h.push({ config, path: null, error: null });
    await h.press(h.terminal, " ", { ctrlKey: true });
    expect(h.element.querySelector(".bottom-bar")?.textContent).toContain(
      "until the next key",
    );
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(h.element.querySelector(".bottom-bar")?.textContent).not.toContain(
      "armed",
    );
    expect((await h.press(h.terminal, "r")).defaultPrevented).toBe(false);
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, " ", { ctrlKey: true });
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      "\x00",
    );
    await h.press(h.terminal, " ", { ctrlKey: true });
    await h.press(h.terminal, "?", { shiftKey: true });
    expect(h.element.querySelector(".keyboard-sheet")?.textContent).toContain(
      "Prefix waits until the next key.",
    );
  } finally {
    await h.close();
  }
});

test("Workbench palette go-to entries use the window dispatcher and effective hints", async () => {
  const h = await harness();
  try {
    const config = structuredClone(defaultKeybindings);
    config.bindings["go-briefs"] = ["g b"];
    await h.push({ config, path: null, error: null });
    await h.press(h.terminal, "k", { metaKey: true });
    const item = [
      ...h.element.querySelectorAll<HTMLElement>("[cmdk-item]"),
    ].find((element) => element.textContent?.includes("Daily brief"));
    expect(item?.textContent).toContain("g b");
    if (!item) throw new Error("Missing Daily brief command");
    await act(async () => item.click());
    expect(h.store.getState().ui.view).toBe("briefs");
    expect(window.loomHost.setMode).toHaveBeenCalledWith("tracker");
    expect(
      h.element.querySelector('[aria-label="Workbench commands"]'),
    ).toBeNull();
  } finally {
    await h.close();
  }
});
