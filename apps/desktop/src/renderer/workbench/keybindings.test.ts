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
    onResize() {}
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

async function harness() {
  const store = createStore(undefined, true, "test");
  store.applyProtocol(
    stateFromSnapshot(meta, { ...emptySnapshotBody(), panes: [pane] }),
  );
  store.setConnection("connected");
  let changed: (state: KeybindingsState) => void = () => {};
  const unsubscribe = vi.fn();
  window.loomHost = {
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
    spawn: vi.fn(async () => ({ pid: 1, command: "fake attach" })),
    kill: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    off: vi.fn(),
  };
  window.loom = { store, ready: true, diffPaintedAt: null, term: null };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: Typed provider requires children.
        children: createElement(Workbench),
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
      h.element.querySelector("#agent-filter"),
      h.element.querySelector(".wb-tabs button"),
      h.element.querySelector("[data-panel] header button"),
    ];
    for (const surface of surfaces) {
      if (!(surface instanceof HTMLElement))
        throw new Error("Missing focus surface");
      surface.focus();
      await h.press(surface, "a", { ctrlKey: true });
      expect(h.element.querySelector(".bottom-bar")?.textContent).toContain(
        "Ctrl+A armed",
      );
      await h.press(surface, "Shift", { shiftKey: true });
      expect(h.element.querySelector(".bottom-bar")?.textContent).toContain(
        "Ctrl+A armed",
      );
      await h.press(surface, "?", { shiftKey: true });
      expect(h.element.querySelector(".wb-help")?.textContent).toContain(
        "Cmd+D / Ctrl+A then |",
      );
      expect(h.element.querySelector(".bottom-bar")?.textContent).not.toContain(
        "armed",
      );
      await act(async () =>
        h.element.querySelector<HTMLButtonElement>(".wb-help button")?.click(),
      );
    }
    h.terminal.focus();
    await h.press(h.terminal, "a", { ctrlKey: true });
    await h.press(h.terminal, "Control", { ctrlKey: true });
    await h.press(h.terminal, "a", { ctrlKey: true });
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      "\x01",
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
    await h.press(h.terminal, "a", { ctrlKey: true });
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
    const help = h.element.querySelector(".wb-help");
    expect(help?.textContent).toContain("Ctrl+Shift+H");
    expect(help?.textContent).toContain("Cmd+U");
    expect(help?.textContent).toContain("4.2 seconds");
    expect(help?.textContent).not.toContain("Ctrl+A then ?");
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
