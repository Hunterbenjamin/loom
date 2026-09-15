// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DetailLayout } from "./detail-layout.js";
import { TrackerHelp } from "./tracker-help.js";

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
  expect(dialog.textContent).toContain("g a · Issues");
  expect(dialog.textContent).toContain("F6 returns focus");
  act(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(close).toHaveBeenCalledOnce();
});
