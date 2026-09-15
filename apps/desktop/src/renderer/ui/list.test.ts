// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { minutesBefore, taskId } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
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
    {
      ...source,
      id: taskId("ci-active"),
      stage: "ci" as const,
      summary: "Checks are running",
    },
    {
      ...source,
      id: taskId("review-active"),
      stage: "in_review" as const,
      summary: "Reviewing",
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
  store.getState().inbox = [
    {
      taskId: taskId("ci-active"),
      reasonRuns: {},
      reviewedHead: null,
      planVersion: 1,
      workTime: { startedAt: null, readyAt: null },
      ci: {
        headSha: "a".repeat(40) as never,
        since: minutesBefore(8),
        conclusion: "pending",
        checks: [
          {
            name: "lint-typecheck-test",
            status: "in_progress",
            conclusion: null,
            url: "https://example.test/check",
          },
        ],
        observedAt: minutesBefore(1),
      },
    },
  ];
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
  expect(h.rows("done")).toHaveLength(10);
  expect(h.button("Done · 46").getAttribute("aria-expanded")).toBe("true");
  // Canceled starts collapsed.
  expect(h.rows("canceled")).toHaveLength(0);
  expect(h.button("Canceled · 46").getAttribute("aria-expanded")).toBe("false");
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(0);
  expect(h.button("Done · 46").getAttribute("aria-expanded")).toBe("false");
  expect(h.host.textContent).toContain("Keep this summary");
  expect(
    h.host.querySelector('[data-task="active"] .wb-status.working'),
  ).not.toBeNull();
  expect(h.host.querySelector('[data-task="active"]')?.textContent).toContain(
    "test-model",
  );
  h.render(false);
  h.render();
  expect(h.button("Done · 46").getAttribute("aria-expanded")).toBe("false");
  // A second window starts expanded independently.
  expect(setup().rows("done")).toHaveLength(10);
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(10);
});

test("renders CI between In progress and In review with live check progress", () => {
  const h = setup();
  const text = h.host.textContent ?? "";
  expect(text.indexOf("In progress ·")).toBeLessThan(text.indexOf("CI ·"));
  expect(text.indexOf("CI ·")).toBeLessThan(text.indexOf("In review ·"));
  const row = h.host.querySelector('[data-task="ci-active"]');
  expect(row?.querySelector('[aria-label="CI running"]')).not.toBeNull();
  expect(row?.textContent).toContain("lint-typecheck-test · running");
  expect(row?.textContent).toContain("8m");
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
  act(() => h.button("Load 10 more").click());
  expect(h.rows("done")).toHaveLength(20);
  expect(h.rows("canceled")).toHaveLength(0);
  expect(h.button("Done · 46")).toBeTruthy();
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(0);
  act(() => h.button("Done · 46").click());
  expect(h.rows("done")).toHaveLength(20);
  act(() => h.button("Load 10 more").click());
  act(() => h.button("Load 10 more").click());
  act(() => h.button("Load 6 more").click());
  expect(h.rows("done")).toHaveLength(46);
  expect(h.host.querySelectorAll(".list-load-more")).toHaveLength(0);
  act(() => h.button("Canceled · 46").click());
  expect(h.rows("canceled")).toHaveLength(10);
  act(() => h.button("Load 10 more").click());
  expect(h.rows("canceled")).toHaveLength(20);
  expect(h.host.querySelectorAll(".list-load-more")).toHaveLength(1);
});

test("j/k and Enter use only expanded, loaded rows in displayed order", () => {
  const h = setup();
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
  key("Enter");
  expect(h.store.getState().ui.openTask).toBeNull();
  act(() => h.button("Done · 46").click());
  act(() => h.button("Canceled · 46").click());
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
  key("j");
  expect(
    h.host.querySelector('[data-cursor="true"]')?.getAttribute("data-task"),
  ).toBe("active");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBe("active");
  key("Escape");
  key("k");
  expect(
    h.host.querySelector('[data-cursor="true"]')?.getAttribute("data-task"),
  ).toBe("active");
  for (let i = 0; i < 30; i++) key("j");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBe("canceled-9");
  key("Escape");
  act(() => h.button("Canceled · 46").click());
  act(() => h.button("In progress · 1").click());
  act(() => h.button("CI · 1").click());
  act(() => h.button("In review · 1").click());
  key("j");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBeNull();
});

test("view changes and mouse movement clear the keyboard cursor", () => {
  const h = setup();
  key("j");
  expect(h.host.querySelector('[data-cursor="true"]')).not.toBeNull();
  act(() =>
    h.host
      .querySelector('[data-testid="list"]')
      ?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })),
  );
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
  key("j");
  act(() => h.store.setView("in-progress"));
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
});

test("uses shared list primitives with sortable column headings and an inline issue key", () => {
  const h = setup();
  expect(h.host.querySelector(".list-group")).not.toBeNull();
  expect(h.host.querySelector(".list-row")).not.toBeNull();
  // No sort dropdown: the column headings name each column and sort by it.
  expect(h.host.querySelector('[aria-label="Sort issues"]')).toBeNull();
  const headings = [
    ...h.host.querySelectorAll<HTMLButtonElement>(".issues-list-head button"),
  ];
  expect(
    headings.map((button) => button.textContent?.replace(/ [↑↓]$/, "")),
  ).toEqual(["Issue", "Stage", "Attention", "Agent", "Round", "Time"]);
  act(() => headings[0]?.click());
  expect(h.store.getState().ui.sort).toBe("title");
  // Each row has one cell per heading after the issue, so values line up under them.
  const row = h.host.querySelector('[data-task="active"]');
  for (const column of ["stage", "attention", "provider", "round"])
    expect(row?.querySelector(`.issues-col-${column}`)).not.toBeNull();
  // The issue key sits on the same line as the name, before it.
  const line = row?.querySelector(".issue-line");
  expect(line?.firstElementChild?.classList.contains("id")).toBe(true);
  expect(line?.children[1]?.classList.contains("task-copy")).toBe(true);
});

test("the Time column shows work from In progress to ready to merge, still counting while in progress", () => {
  const h = setup();
  const noWork = { reasonRuns: {}, reviewedHead: null, planVersion: 1 };
  h.store.getState().inbox = [
    ...h.store.getState().inbox,
    {
      ...noWork,
      taskId: taskId("active"),
      workTime: { startedAt: minutesBefore(25), readyAt: null },
      ci: null,
    },
    {
      ...noWork,
      taskId: taskId("done-0"),
      workTime: { startedAt: minutesBefore(120), readyAt: minutesBefore(40) },
      ci: null,
    },
  ];
  h.render(false);
  h.render();
  const time = (id: string) =>
    h.host.querySelector(`[data-task="${id}"] .list-row-age > span`);
  expect(time("done-0")?.textContent).toBe("1h 20m");
  expect(time("done-0")?.getAttribute("title")).toContain(
    "from In progress to ready to merge",
  );
  expect(time("active")?.textContent).toBe("25m");
  expect(time("active")?.classList.contains("work-running")).toBe(true);
  expect(time("done-1")?.textContent).toBe("—");
});
