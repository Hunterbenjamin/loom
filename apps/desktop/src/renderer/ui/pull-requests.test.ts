// @vitest-environment happy-dom
import { stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { pullRequestSubscriptions } from "../store/pull-requests.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { useShortcuts } from "./keys.js";
import { PullRequestsView } from "./pull-requests.js";
import { Sidebar } from "./sidebar.js";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    scrollMargin?: number;
    getItemKey: (index: number) => string;
  }) => ({
    getTotalSize: () => options.count * 40,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: (options.scrollMargin ?? 0) + index * 40,
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

test("renders the reference sections, compact glyph rows and viewer count", () => {
  const h = setup();
  expect(h.rows()).toHaveLength(4);
  const labels = [...h.host.querySelectorAll(".reviews-group")].map(
    (b) => b.textContent,
  );
  expect(labels).toEqual([
    "Ready to merge1▾",
    "Needs attention1▾",
    "Waiting1▾",
    "Created by you1▾",
    "Completed24▸",
  ]);
  expect(h.host.querySelector('[data-view="pull-requests"]')?.textContent).toBe(
    "Review3",
  );
  expect(h.host.querySelector("thead")).toBeNull();
  expect(
    h.host.querySelectorAll('.review-status[aria-label="Checks failed"]'),
  ).toHaveLength(1);
  expect(
    h.host.querySelectorAll('.review-status[aria-label="Checks pending"]'),
  ).toHaveLength(1);
  expect(h.host.querySelectorAll(".pr-open")).toHaveLength(4); // rows; the nav uses its own icon
  act(() => h.button("Created").click());
  expect(h.rows()).toHaveLength(2);
  expect(
    h
      .rows()
      .every((row) =>
        [203, 204].some((n) => row.dataset.pr?.includes(String(n))),
      ),
  ).toBe(true);
  expect(
    h.host.querySelector('[data-view="pull-requests"] .count')?.textContent,
  ).toBe("3");
  act(() => h.button("For you").click());
  act(() => h.store.setPrQuery("KEYBOARD"));
  expect(h.rows()).toHaveLength(1);
  expect(h.rows()[0]?.textContent).toContain("Improve keyboard navigation");
  act(() => h.store.setPrQuery("nothing matches"));
  expect(h.rows()).toHaveLength(0);
  expect(h.host.textContent).toContain("No reviews match this filter.");
});

test("keyboard skips collapsed sections; Enter opens the PR and issue links open only the issue", () => {
  const h = setup();
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
  key("Enter");
  expect(h.store.getState().ui.openPr).toBeNull();
  act(() => h.button("Needs attention1▾").click());
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
  key("j");
  expect(h.host.querySelector('[data-cursor="true"]')).toBe(h.rows()[0]);
  key("k");
  expect(h.host.querySelector('[data-cursor="true"]')).toBe(h.rows()[0]);
  key("j");
  expect(h.rows()[1]?.textContent).toContain("Improve keyboard navigation");
  key("Enter");
  expect(h.store.getState().ui.openPr?.number).toBe(202);
  key("Escape");
  key("k");
  key("/");
  const input = h.host.querySelector<HTMLInputElement>("[data-pr-search]");
  if (!input) throw new Error("missing search");
  expect(document.activeElement).toBe(input);
  key("j", input);
  expect(h.store.getState().ui.prCursor).toBe(0);
  act(() => h.store.setPrQuery("keyboard"));
  key("Escape", input);
  expect(h.store.getState().ui.prQuery).toBe("");
  const task = h.host.querySelector<HTMLButtonElement>(".pr-task-link");
  if (!task) throw new Error("missing issue link");
  expect(key("Enter", task).defaultPrevented).toBe(false);
  act(() => task.click());
  expect(h.store.getState().ui.openTask).toBe(task.textContent);
  expect(h.store.getState().ui.openPr).toBeNull();
  key("Escape");
  const header = h.button("Completed24▸");
  key("Enter", header);
  expect(h.store.getState().ui.openPr).toBeNull();
  act(() => header.click());
  expect(h.rows()).toHaveLength(23);
  expect(h.host.querySelectorAll(".pr-merged")).toHaveLength(10);
  expect(h.host.querySelectorAll(".pr-closed")).toHaveLength(10);
});

test("tab changes and mouse movement clear the keyboard cursor", () => {
  const h = setup();
  key("j");
  expect(h.host.querySelector('[data-cursor="true"]')).not.toBeNull();
  act(() =>
    h.host
      .querySelector('[data-testid="pull-requests-list"]')
      ?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })),
  );
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
  key("j");
  act(() => h.button("Created").click());
  expect(h.host.querySelector('[data-cursor="true"]')).toBeNull();
});

test("Completed starts collapsed, loads 20 at a time, newest completion first, and retains presentation state", () => {
  const h = setup();
  const wire = toSnapshot(buildSnapshot());
  const first = wire.body.pullRequests[0];
  if (!first) throw new Error("missing PR");
  wire.body.pullRequests = Array.from({ length: 45 }, (_, i) => ({
    ...first,
    number: i + 1,
    state: i % 2 ? ("closed" as const) : ("merged" as const),
    completedAt: new Date(
      Date.UTC(2026, 8, 1, 0, i),
    ).toISOString() as typeof first.completedAt,
  }));
  act(() => h.store.applyProtocol(stateFromSnapshot(wire.meta, wire.body)));
  expect(h.rows()).toHaveLength(0);
  act(() => h.button("Completed45▸").click());
  expect(h.rows()).toHaveLength(20);
  expect(h.rows()[0]?.dataset.pr).toContain(",45]");
  act(() => h.button("Load 20 more").click());
  expect(h.rows()).toHaveLength(40);
  act(() => h.button("Load 5 more").click());
  expect(h.rows()).toHaveLength(45);
  act(() => {
    h.store.setView("all");
    h.store.setView("pull-requests");
  });
  expect(h.rows()).toHaveLength(45);
  act(() => h.button("Completed45▾").click());
  key("j");
  key("Enter");
  expect(h.store.getState().ui.openPr).toBeNull();
});

test("subscriptions load history only while Reviews is visible", () => {
  const h = setup();
  const repoId = h.store.getState().ui.repo;
  const open = { kind: "pull_requests", repoId, state: "open" };
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([open]);
  act(() => h.store.setTrackerVisible(true));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([
    open,
    { ...open, state: "merged" },
    { ...open, state: "closed" },
  ]);
  act(() => h.store.setPrTab("created"));
  act(() => h.store.setView("all"));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([open]);
  act(() => h.store.setView("pull-requests"));
  expect(h.store.getState().ui.prTab).toBe("created");
  act(() => h.store.setTrackerVisible(false));
  expect(pullRequestSubscriptions(h.store.getState())).toEqual([open]);
});

test("shows loading from live list state and the empty result", () => {
  const h = setup();
  const wire = toSnapshot(buildSnapshot());
  const repoId = wire.body.repos[0]?.id;
  if (!repoId) throw new Error("Missing repo");
  wire.body.pullRequests = [];
  wire.body.pullRequestLists = [{ repoId, state: "open", loading: true }];
  act(() => h.store.applyProtocol(stateFromSnapshot(wire.meta, wire.body)));
  expect(h.host.textContent).toContain("Loading reviews…");
  wire.body.pullRequestLists = [{ repoId, state: "open", loading: false }];
  act(() => h.store.applyProtocol(stateFromSnapshot(wire.meta, wire.body)));
  expect(h.host.textContent).toContain("No reviews for you.");
});
