// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { paneIndicator } from "./selectors.js";
import { Status } from "./status.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("all working indicators share one 80 ms interval, pause when hidden and respect reduced motion", async () => {
  vi.useFakeTimers();
  const interval = vi.spyOn(globalThis, "setInterval");
  const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = false;
  vi.spyOn(motion, "matches", "get").mockImplementation(() => reduced);
  vi.spyOn(window, "matchMedia").mockReturnValue(motion);
  const element = document.createElement("div");
  const root = createRoot(element);
  const render = (count: number) =>
    root.render(
      createElement(
        "div",
        null,
        Array.from({ length: count }, (_, key) =>
          createElement(Status, {
            key,
            state: paneIndicator({ ...pane, status: "working" }),
          }),
        ),
      ),
    );
  const glyphs = () =>
    [...element.querySelectorAll(".wb-status")].map((el) => el.textContent);
  try {
    await act(async () => render(30));
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0]?.[1]).toBe(80);
    expect(new Set(glyphs())).toEqual(new Set(["⠋"]));
    await act(async () => vi.advanceTimersByTime(80));
    expect(new Set(glyphs())).toEqual(new Set(["⠙"]));
    await act(async () => render(50));
    expect(interval).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(720));
    expect(new Set(glyphs())).toEqual(new Set(["⠋"]));
    await act(async () => {
      visibility.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(800));
    expect(new Set(glyphs())).toEqual(new Set(["⠋"]));
    await act(async () => {
      visibility.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      reduced = true;
      motion.dispatchEvent(new Event("change"));
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(new Set(glyphs())).toEqual(new Set(["◌"]));
    await act(async () => {
      reduced = false;
      motion.dispatchEvent(new Event("change"));
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => render(0));
    expect(vi.getTimerCount()).toBe(0);
    // A window that starts with reduced motion must never start the clock.
    reduced = true;
    interval.mockClear();
    await act(async () => render(2));
    expect(interval).not.toHaveBeenCalled();
    expect(new Set(glyphs())).toEqual(new Set(["◌"]));
  } finally {
    await act(async () => root.unmount());
  }
  expect(vi.getTimerCount()).toBe(0);
});

test("status glyphs have accessible labels without icon chrome", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          ["idle", "blocked", "ended", "failed", "unknown"].map((status) =>
            createElement(Status, {
              key: status,
              state: paneIndicator({ ...pane, status }),
            }),
          ),
        ),
      ),
    );
    expect(
      [...element.querySelectorAll('[role="img"]')].map((el) => [
        el.textContent,
        el.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["○", "Idle"],
      ["●", "Blocked"],
      ["●", "Ended"],
      ["!", "Failed"],
      ["?", "Status unavailable"],
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
