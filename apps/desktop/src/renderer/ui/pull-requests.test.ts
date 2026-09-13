// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import {
  pullRequestSubscriptions,
  selectedPullRequests,
} from "../store/pull-requests.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { useShortcuts } from "./keys.js";
import { PullRequestsView } from "./pull-requests.js";
import { Sidebar } from "./sidebar.js";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey: (index: number) => string;
  }) => ({
    getTotalSize: () => options.count * 40,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 40,
        size: 40,
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
  const store = createStore(buildSnapshot());
  store.setView("pull-requests");
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
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider children
        children: [
          createElement(Keyboard, { key: "keys" }),
          createElement(Sidebar, { key: "sidebar" }),
          createElement(PullRequestsView, { key: "list" }),
        ],
      }),
    ),
  );
  const rows = () => [...host.querySelectorAll<HTMLElement>("[data-pr]")];
  const button = (text: string) => {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
    if (!button) throw new Error(`Missing button ${text}`);
    return button;
  };
  return { store, host, rows, button };
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

test("renders every field and badge, filters states separately and keeps the open sidebar count", () => {
  const h = setup();
  expect(h.rows()).toHaveLength(8);
  const content = h.host.textContent;
  for (const text of [
    "→ main",
    "fixture-contributor",
    "30m",
    "Pass",
    "Pending",
    "Fail",
    "No checks",
    "Approved",
    "Changes requested",
    "None",
    "Mergeable",
    "Conflicts",
    "Unknown",
    "Draft",
  ])
    expect(content).toContain(text);
  act(() => h.store.setRepo(h.store.getState().snapshot.repos[0]?.id ?? ""));
  expect(h.rows()).toHaveLength(4);
  const count = () =>
    h.host.querySelector('[data-view="pull-requests"] .count')?.textContent;
  expect(count()).toBe("4");
  act(() => h.button("Merged").click());
  expect(h.rows()).toHaveLength(1);
  expect(h.rows()[0]?.textContent).toContain("#205");
  expect(count()).toBe("4");
  act(() => h.button("Closed").click());
  expect(h.rows()[0]?.textContent).toContain("#206");
  act(() => h.button("Open").click());
  act(() => h.store.setPrQuery("KEYBOARD"));
  expect(h.rows()).toHaveLength(1);
  expect(h.rows()[0]?.textContent).toContain("#202");
  act(() => h.store.setPrQuery("no matching pr"));
  expect(h.rows()).toHaveLength(0);
  expect(h.host.textContent).toContain("No pull requests match this filter.");
  key("j");
  key("Enter");
  expect(h.store.getState().ui.openTask).toBeNull();
});

test("j/k follows displayed order, search owns typing, and task links open only their task", () => {
  const h = setup();
  key("j");
  expect(h.rows()[1]?.dataset.cursor).toBe("true");
  expect(key("Enter").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(h.rows()[1]);
  key("k");
  expect(h.rows()[0]?.dataset.cursor).toBe("true");
  for (let i = 0; i < 12; i++) key("j");
  expect(h.rows().at(-1)?.dataset.cursor).toBe("true");
  key("/");
  const input = h.host.querySelector<HTMLInputElement>("[data-pr-search]");
  if (!input) throw new Error("missing search");
  expect(document.activeElement).toBe(input);
  const cursor = h.store.getState().ui.prCursor;
  key("k", input);
  expect(h.store.getState().ui.prCursor).toBe(cursor);
  act(() => h.store.setPrQuery("keyboard"));
  key("Escape", input);
  expect(h.store.getState().ui.prQuery).toBe("");
  const task = h.host.querySelector<HTMLButtonElement>(".pr-task-link");
  if (!task) throw new Error("missing task link");
  expect(key("Enter", task).defaultPrevented).toBe(false);
  // happy-dom does not synthesize native keyboard clicks.
  act(() => task.click());
  expect(h.store.getState().ui.openTask).toBe(task.textContent);
  key("Escape");
  expect(h.store.getState().ui.openTask).toBeNull();
  act(() => h.rows()[2]?.click());
  expect(h.store.getState().ui.prCursor).toBe(2);
  key("e");
  expect(h.store.getState().ui.stagePicker).toBe(false);
});

test("subscriptions follow repository, state and visibility without PR details or commands", () => {
  const h = setup();
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([]);
  act(() => h.store.setTrackerVisible(true));
  expect(pullRequestSubscriptions(h.store.getState())).toHaveLength(2);
  const repo = h.store.getState().snapshot.repos[0];
  if (!repo) throw new Error("missing repo");
  act(() => {
    h.store.setRepo(repo.id);
    h.store.setPrState("closed");
  });
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([
    { kind: "pull_requests", repoId: repo.id, state: "open" },
    { kind: "pull_requests", repoId: repo.id, state: "closed" },
  ]);
  act(() => h.store.setView("all"));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([]);
  act(() => h.store.setView("pull-requests"));
  expect(h.store.getState().ui.prState).toBe("closed");
  act(() => h.store.setTrackerVisible(false));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([]);
  expect(createStore().getState().ui.prState).toBe("open");
});

test("sorts by creation time and searches branch, author, number and linked key", () => {
  const store = createStore();
  const rows = selectedPullRequests(store.getState());
  expect(rows.map((pr) => pr.createdAt)).toEqual(
    rows
      .map((pr) => pr.createdAt)
      .sort()
      .reverse(),
  );
  for (const query of [
    "#201",
    "fixture-contributor",
    "feat/example-2",
    "main",
    rows[0]?.taskId ?? "",
  ]) {
    store.setPrQuery(query);
    expect(selectedPullRequests(store.getState()).length).toBeGreaterThan(0);
  }
});
