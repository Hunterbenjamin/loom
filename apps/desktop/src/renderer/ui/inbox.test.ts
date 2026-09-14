// @vitest-environment happy-dom

import type { AttentionReason, Run } from "@loom/core";
import { stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { REASON_LABELS } from "../store/inbox.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Detail } from "./detail.js";
import { InboxView } from "./inbox.js";
import { useShortcuts } from "./keys.js";
import { ListView } from "./list.js";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 94,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 94,
        size: 94,
      })),
    scrollToIndex() {},
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const fn of cleanups.splice(0)) fn();
  });
});

function setup(reason: AttentionReason, mode: Run["mode"] = "interactive") {
  const fixture = buildSnapshot();
  const task = fixture.tasks[0];
  const originalRun = fixture.runs[0];
  if (!task || !originalRun) throw new Error("missing fixture");
  task.attention = {
    reasons: [reason],
    since: fixture.now,
    reasonSince: { [reason]: fixture.now },
  };
  if (reason === "plan_needs_approval") task.stage = "plan_approval";
  if (reason === "needs_approval") task.stage = "awaiting_approval";
  for (const other of fixture.tasks)
    if (other.id !== task.id)
      other.attention = { reasons: [], reasonSince: {}, since: null };
  const run = { ...originalRun, taskId: task.id, mode };
  const store = createStore(fixture, true);
  const { body, meta } = toSnapshot(fixture);
  body.inbox = [
    {
      taskId: task.id,
      reasonRuns: { [reason]: [run] },
      planVersion: 7,
      reviewedHead: "a".repeat(40) as never,
    },
  ];
  store.applyProtocol(stateFromSnapshot(meta, body));
  store.setConnection("connected");
  store.setView("needs-you");
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
  const render = (child: ReturnType<typeof createElement>) =>
    act(() => {
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
          children: [createElement(Keyboard, { key: "keys" }), child],
        }),
      );
    });
  render(createElement(InboxView, { key: "inbox" }));
  return { store, host, render, task, run };
}

const tabs: Record<AttentionReason, string> = {
  plan_needs_approval: "overview",
  needs_approval: "overview",
  question: "overview",
  provider_permission: "terminal",
  provider_input: "terminal",
  blocked: "overview",
  failed: "overview",
  run_vanished: "overview",
  stalled: "overview",
  idle_without_submission: "overview",
  status_unknown: "overview",
  observability_failure: "overview",
  over_budget: "overview",
};
for (const [reason, tab] of Object.entries(tabs))
  test(`selecting ${reason} opens ${tab} with its exact run`, () => {
    const h = setup(reason as AttentionReason);
    const row = h.host.querySelector<HTMLButtonElement>("[data-reason]");
    expect(row?.textContent).toContain(
      REASON_LABELS[reason as AttentionReason],
    );
    act(() => row?.click());
    expect(h.store.getState().ui).toMatchObject({
      openTask: h.task.id,
      openRun: h.run.id,
      tab,
    });
  });

test("renders section headers and rows through the shared list primitives", () => {
  const h = setup("plan_needs_approval");
  expect(h.host.querySelector(".list-row")?.getAttribute("data-reason")).toBe(
    "plan_needs_approval",
  );
  expect(h.host.querySelector(".list-group")?.textContent).toContain(
    "Decisions",
  );
  expect(h.host.querySelector(".list-row")?.textContent).toContain("plan v7");
});
for (const reason of [
  "question",
  "provider_permission",
  "provider_input",
] as const)
  test(`headless ${reason} routes to Overview with Enter`, () => {
    const h = setup(reason, "headless");
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })),
    );
    expect(h.store.getState().ui.tab).toBe("overview");
  });

test("merge approval sends the full displayed reviewed SHA once and shows rejection", async () => {
  const h = setup("needs_approval");
  act(() => h.host.querySelector<HTMLButtonElement>("[data-reason]")?.click());
  const sender = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: "guard_failed" as const,
      message: "Head changed",
      details: [],
    },
  }));
  h.store.setSender(sender);
  h.render(createElement(Detail, { task: h.task, key: "actions" }));
  await act(async () => {
    [...h.host.querySelectorAll("button")]
      .find((b) => b.textContent === "Approve merge")
      ?.click();
  });
  expect(sender).not.toHaveBeenCalled();
  // The confirmation shows the full reviewed SHA it will approve.
  expect(h.host.querySelector(".pr-confirm")?.textContent).toContain(
    "a".repeat(40),
  );
  await act(async () => {
    [...h.host.querySelectorAll("button")]
      .find((b) => b.textContent === "Confirm approval")
      ?.click();
  });
  expect(sender).toHaveBeenCalledExactlyOnceWith({
    kind: "human",
    taskId: h.task.id,
    command: { type: "approve", headSha: "a".repeat(40) },
  });
  expect(
    h.host.querySelector('.issue-toolbar-action [role="alert"]')?.textContent,
  ).toContain("Head changed");
  expect(h.store.getState().snapshot.tasks[0]?.attention.reasons).toContain(
    "needs_approval",
  );
});

test("an unrelated detail patch does not render the list again", () => {
  const h = setup("failed");
  h.store.setView("all");
  h.render(createElement(ListView, { key: "list" }));
  const before = h.host.innerHTML;
  const { body, meta } = toSnapshot(h.store.getState().snapshot);
  const client = stateFromSnapshot(meta, body);
  const transition = body.transitions[0];
  if (!transition) throw new Error("missing transition");
  const patch = {
    type: "patch" as const,
    seq: meta.seq + 1,
    now: meta.now,
    changes: [
      {
        op: "upsert" as const,
        collection: "transition" as const,
        value: transition,
      },
    ],
  };
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) =>
    mutations.push(...records),
  );
  observer.observe(h.host, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  act(() => h.store.applyProtocol(client, patch));
  expect(h.host.innerHTML).toBe(before);
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});
