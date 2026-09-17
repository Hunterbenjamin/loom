// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { defaultKeybindingsState } from "../../shared/keybindings.js";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { WindowKeybindings } from "../window-keybindings.js";
import { DetailLayout } from "./detail-layout.js";
import { useShortcuts } from "./keys.js";

// This test models the terminal input element; xterm itself is covered in terminal.test.ts.
vi.mock("./terminal.js", () => ({ enterFocusedScrollMode: vi.fn() }));

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

test("details focus their controls, leave terminal input through the prefix, and restore focus", async () => {
  window.loomHost = {
    keybindings: async () => defaultKeybindingsState,
    onKeybindingsChanged: () => () => {},
  } as unknown as typeof window.loomHost;
  const store = createFixtureStore(buildSnapshot(2));
  function Shortcuts() {
    useShortcuts(store);
    return null;
  }
  const previous = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(previous, host);
  previous.focus();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: createElement(
          WindowKeybindings,
          { mode: "tracker" },
          createElement(Shortcuts),
          createElement(DetailLayout, {
            breadcrumb: "Issue",
            testId: "detail",
            onClose: vi.fn(),
            // biome-ignore lint/correctness/noChildrenProp: DetailLayout requires children in its typed props.
            children: createElement(
              "div",
              { className: "xterm" },
              createElement("textarea"),
            ),
          }),
        ),
      }),
    ),
  );
  const header = host.querySelector("header");
  expect(document.activeElement).toBe(header);
  const terminal = host.querySelector("textarea")!;
  terminal.focus();
  const press = (
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
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  expect(press(terminal, "F6").defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(terminal);
  press(terminal, " ", { ctrlKey: true });
  press(terminal, "Escape");
  expect(document.activeElement).toBe(terminal);
  press(terminal, " ", { ctrlKey: true });
  expect(press(terminal, "q").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(header);
  press(header!, "g");
  press(header!, "n");
  expect(store.getState().ui.view).toBe("needs-you");
  act(() => root.unmount());
  expect(document.activeElement).toBe(previous);
});
