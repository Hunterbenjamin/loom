// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { DetailLayout } from "./detail-layout.js";
import { TrackerHelp } from "./tracker-help.js";
import { trackerKeymap } from "./tracker-keymap.js";

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

test("details focus their controls, provide a terminal focus exit, and restore focus", () => {
  const previous = document.createElement("button");
  const host = document.createElement("div");
  document.body.append(previous, host);
  previous.focus();
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store: createFixtureStore(buildSnapshot(2)),
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: createElement(DetailLayout, {
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
      }),
    ),
  );
  const header = host.querySelector("header");
  expect(document.activeElement).toBe(header);
  const terminal = host.querySelector("textarea")!;
  terminal.focus();
  const key = new KeyboardEvent("keydown", {
    key: "F6",
    bubbles: true,
    cancelable: true,
  });
  terminal.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(header);
  act(() => root.unmount());
  expect(document.activeElement).toBe(previous);
});

test("help is a labeled modal with the complete map and Escape dismissal", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => root.unmount());
  const close = vi.fn();
  act(() => root.render(createElement(TrackerHelp, { onClose: close })));
  const dialog = host.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  for (const entry of trackerKeymap)
    expect(
      dialog.querySelector(`[data-key-id="${entry.id}"]`)?.textContent,
    ).toContain(entry.label);
  expect(dialog.textContent).toContain("⌘Enter");
  act(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).toHaveBeenCalledOnce();
});
