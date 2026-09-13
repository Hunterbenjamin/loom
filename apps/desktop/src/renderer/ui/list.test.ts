// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { minutesBefore, taskId } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { useShortcuts } from "./keys.js";
import { ListView } from "./list.js";

// Only layout is mocked: happy-dom has no viewport measurements.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey: (index: number) => string;
  }) => ({
    getTotalSize: () => options.count * 32,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 32,
        size: 32,
      })),
    scrollToIndex() {},
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() =>
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  }),
);

function setup() {
  const fixture = buildSnapshot();
  const source = fixture.tasks[0];
  if (!source) throw new Error("missing fixture task");
  const tasks = [
    {
      ...source,
      id: taskId("active"),
      stage: "in_progress" as const,
      summary: "Keep this summary",
    },
    ...(["done", "canceled"] as const).flatMap((stage) =>
      Array.from({ length: 46 }, (_, i) => ({
        ...source,
        id: taskId(`${stage}-${i}`),
        stage,
        stageEnteredAt: minutesBefore(i),
      })),
    ),
  ];
  const run = fixture.runs[0];
  if (!run) throw new Error("missing fixture run");
  const store = createStore({
    ...fixture,
    tasks,
    runs: [
      {
        ...run,
        taskId: taskId("active"),
        status: "working",
        model: "test-model",
      },
    ],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  function Keyboard() {
    useShortcuts(store);
    return null;
  }
  const render = (show = true) =>
    act(() =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: typed StoreProvider children
          children: [
            createElement(Keyboard, { key: "keys" }),
            show ? createElement(ListView, { key: "list" }) : null,
          ],
        }),
      ),
    );
  render();
  const button = (text: string) => {
    const result = [...host.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!result) throw new Error(`Missing button: ${text}`);
    return result;
  };
  const rows = (stage: string) =>
    host.querySelectorAll(`[data-task^="${stage}-"]`);
  return { host, store, button, rows, render };
}

function key(key: string, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

test("collapses to the total header, expands again, and retains window-only settings on remount", () => {
  const h = setup();
  expect(h.rows("done")).toHaveLength(20);
  expect(h.button("Done · 46").getAttribute("aria-expanded")).toBe("true");
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(0);
  expect(h.button("Done · 46").getAttribute("aria-expanded")).toBe("false");
  expect(h.rows("canceled")).toHaveLength(20);
  expect(h.host.textContent).toContain("Keep this summary");
  expect(
    h.host.querySelector('[data-task="active"] .dot-animated'),
  ).not.toBeNull();
  expect(h.host.querySelector('[data-task="active"]')?.textContent).toContain(
    "test-model",
  );
  h.render(false);
  h.render();
  expect(h.button("Done · 46").getAttribute("aria-expanded")).toBe("false");
  // A second window starts expanded independently.
  expect(setup().rows("done")).toHaveLength(20);
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(20);
});

test.each(["Enter", " "])(
  "header %s activation leaves the native button action available without opening a task",
  (pressed) => {
    const h = setup();
    const header = h.button("Done · 46");
    header.focus();
    expect(header.type).toBe("button");
    expect(key(pressed, header).defaultPrevented).toBe(false);
    expect(h.store.getState().ui.openTask).toBeNull();
    // happy-dom does not synthesize native keyboard clicks.
    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    key(pressed, header);
    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(h.store.getState().ui.openTask).toBeNull();
  },
);

test("loads successive pages independently and retains totals and loaded rows across collapse", () => {
  const h = setup();
  act(() => h.button("Load 20 more").click());
  expect(h.rows("done")).toHaveLength(40);
  expect(h.rows("canceled")).toHaveLength(20);
  expect(h.button("Done · 46")).toBeTruthy();
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(0);
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(40);
  act(() => h.button("Load 6 more").click());
  expect(h.rows("done")).toHaveLength(46);
  expect(h.host.querySelectorAll(".list-load-more")).toHaveLength(1);
  act(() => h.button("Load 20 more").click());
  expect(h.rows("canceled")).toHaveLength(40);
  act(() => h.button("Load 6 more").click());
  expect(h.rows("canceled")).toHaveLength(46);
  expect(h.host.querySelectorAll(".list-load-more")).toHaveLength(0);
});

test("j/k and Enter use only expanded, loaded rows in displayed order", () => {
  const h = setup();
  act(() => h.button("Done · 46").click());
  key("j");
  expect(
    h.host.querySelector('[data-cursor="true"]')?.getAttribute("data-task"),
  ).toBe("canceled-0");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBe("canceled-0");
  key("Escape");
  key("k");
  expect(
    h.host.querySelector('[data-cursor="true"]')?.getAttribute("data-task"),
  ).toBe("active");
  for (let i = 0; i < 30; i++) key("j");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBe("canceled-19");
  key("Escape");
  act(() => h.button("Canceled · 46").click());
  act(() => h.button("In progress · 1").click());
  key("j");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBeNull();
});
