// @vitest-environment happy-dom

import { stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { inputId, questionId, transitionId } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Detail } from "./detail.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: (() => void)[] = [];
afterEach(() =>
  act(() => {
    for (const fn of cleanup.splice(0)) fn();
  }),
);

function setup(
  kind: "plan" | "merge" | "question" | "failed" | "provider" = "plan",
) {
  const snapshot = buildSnapshot(8);
  const task = snapshot.tasks[0];
  if (!task) throw new Error("missing task");
  task.stage =
    kind === "plan"
      ? "plan_approval"
      : kind === "merge"
        ? "awaiting_approval"
        : "in_progress";
  const reason = {
    plan: "plan_needs_approval",
    merge: "needs_approval",
    question: "question",
    failed: "failed",
    provider: "provider_permission",
  } as const;
  task.attention = {
    reasons: [reason[kind]],
    reasonSince: { [reason[kind]]: snapshot.now },
    since: snapshot.now,
  };
  if (kind === "question") {
    const run = snapshot.runs[0];
    if (!run) throw new Error("missing question run");
    run.taskId = task.id;
    snapshot.questions.push({
      id: questionId("navigation-question"),
      taskId: task.id,
      runId: run.id,
      question: "Which approach should we use?",
      options: [],
      blocking: true,
      askedAt: snapshot.now,
      answer: null,
      answeredAt: null,
    });
  }
  if (kind === "provider") {
    const run = snapshot.runs[0];
    if (!run) throw new Error("missing provider run");
    run.taskId = task.id;
    run.endedAt = null;
    run.pendingRequests = [
      {
        id: "navigation-request",
        generation: 4,
        kind: "permission",
        blocking: true,
        summary: "Use the network",
        receivedAt: snapshot.now,
      },
    ];
  }
  snapshot.plans[task.id] = {
    goal: "A clear plan",
    nonGoals: [],
    steps: [{ title: "Build", detail: "Implement it" }],
    areas: [],
    acceptanceCriteria: [],
    testPlan: [],
    risks: [],
    openQuestions: [],
    suggestedImplementer: null,
    version: 9,
  };
  const store = createStore(snapshot, true, "dev");
  store.getState().inbox = [
    {
      taskId: task.id,
      reasonRuns: {},
      reviewedHead: kind === "merge" ? ("b".repeat(40) as never) : null,
      planVersion: kind === "plan" ? 9 : null,
    },
  ];
  store.setConnection("connected");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup.push(() => {
    root.unmount();
    host.remove();
  });
  const render = () =>
    act(() =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
          children: createElement(Detail, { task }),
        }),
      ),
    );
  return { store, task, host, render, snapshot };
}

test("plan approval opened from the Issues list shows the current plan actions", () => {
  const h = setup("plan");
  h.store.open(h.task.id);
  h.render();
  expect(h.host.textContent).toContain("Plan version 9");
  expect(
    [...h.host.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual(expect.arrayContaining(["Approve plan", "Reject plan"]));
  expect(h.host.textContent).toContain("Enter feedback to reject the plan");
});

test("entering a note does not clear a coordinator availability reason", () => {
  const h = setup("plan");
  h.store.setConnection("disconnected");
  h.render();
  const textarea = h.host.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("missing feedback field");
  act(() => {
    textarea.value = "Please revise the plan";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const reject = [...h.host.querySelectorAll("button")].find(
    (button) => button.textContent === "Reject plan",
  );
  expect(reject?.disabled).toBe(true);
  expect(h.host.textContent).toContain("Connect to the coordinator");
});

test.each(["plan", "merge", "question", "failed", "provider"] as const)(
  "%s actions and disabled states do not depend on the opening path",
  (kind) => {
    const h = setup(kind);
    h.store.openAttention(
      h.task.id,
      h.task.attention.reasons[0] as never,
      "overview",
      null,
    );
    h.render();
    const inbox = [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-decision-actions button",
      ),
    ].map((button) => `${button.textContent}:${button.disabled}`);
    act(() => h.store.open(h.task.id));
    const list = [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-decision-actions button",
      ),
    ].map((button) => `${button.textContent}:${button.disabled}`);
    expect(list).toEqual(inbox);
    act(() => {
      h.store.openPullRequest({
        repoId: h.task.repoId,
        number: h.task.prNumber ?? 1,
      });
      h.store.open(h.task.id);
    });
    const breadcrumb = [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-decision-actions button",
      ),
    ].map((button) => `${button.textContent}:${button.disabled}`);
    expect(breadcrumb).toEqual(inbox);
  },
);

test("provider requests expose their primary action in the toolbar", () => {
  const h = setup("provider");
  h.render();
  expect(
    h.host.querySelector(".issue-toolbar-action button")?.textContent,
  ).toBe("Accept");
});

test("cancel requires a reason before sending it", async () => {
  const h = setup("failed");
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: inputId("cancel-issue") },
  }));
  h.store.setSender(sender);
  h.render();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel issue")
      ?.click(),
  );
  const confirm = [
    ...h.host.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Confirm cancellation");
  expect(confirm?.disabled).toBe(true);
  const reason = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Cancellation reason"]',
  );
  if (!reason) throw new Error("missing cancellation reason");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(reason, "No longer needed");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(confirm?.disabled).toBe(false);
  await act(async () => confirm?.click());
  expect(sender).toHaveBeenCalledExactlyOnceWith({
    kind: "human",
    taskId: h.task.id,
    command: { type: "cancel", reason: "No longer needed" },
  });
});

test("approve confirms the displayed evidence before sending once and renders a refusal", async () => {
  const h = setup("merge");
  const sender = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: "guard_failed" as const,
      message: "Head changed",
      details: ["Review the latest head"],
    },
  }));
  h.store.setSender(sender);
  h.render();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve merge")
      ?.click(),
  );
  expect(sender).not.toHaveBeenCalled();
  const dialog = h.host.querySelector<HTMLDialogElement>(".pr-confirm");
  expect(dialog?.textContent).toContain("b".repeat(40));
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Confirm approval")
      ?.click(),
  );
  expect(sender).toHaveBeenCalledExactlyOnceWith({
    kind: "human",
    taskId: h.task.id,
    command: { type: "approve", headSha: "b".repeat(40) },
  });
  expect(h.host.querySelector('[role="status"]')?.textContent).toContain(
    "guard_failed: Head changed",
  );
  expect(h.host.querySelector('[role="status"]')?.textContent).toContain(
    "Review the latest head",
  );
});

test("the toolbar and panel share the same merge approval confirmation", async () => {
  const h = setup("merge");
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: inputId("confirmed-merge") },
  }));
  h.store.setSender(sender);
  h.render();
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>(".issue-decision-actions button")
      ?.click(),
  );
  expect(h.host.querySelectorAll(".pr-confirm")).toHaveLength(1);
  expect(sender).not.toHaveBeenCalled();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel")
      ?.click(),
  );
  expect(h.host.querySelector(".pr-confirm")).toBeNull();
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>(".issue-toolbar-action button")
      ?.click(),
  );
  expect(h.host.querySelectorAll(".pr-confirm")).toHaveLength(1);
  expect(sender).not.toHaveBeenCalled();
});

test("merge confirmation refuses a reviewed head that changed while open", async () => {
  const h = setup("merge");
  h.render();
  await act(async () =>
    h.host
      .querySelector<HTMLButtonElement>(".issue-toolbar-action button")
      ?.click(),
  );
  h.store.getState().inbox = [
    {
      taskId: h.task.id,
      reasonRuns: {},
      reviewedHead: "c".repeat(40) as never,
      planVersion: null,
    },
  ];
  await act(async () => h.store.setConnection("connected"));
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(
    "reviewed head changed",
  );
  expect(
    [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Confirm approval",
    )?.disabled,
  ).toBe(true);
});

test("a queued command becomes applied from its matching transition without exposing the input id", async () => {
  const h = setup("plan");
  const queuedId = inputId("hidden-command-id");
  h.store.setSender(
    vi.fn(async () => ({
      ok: true as const,
      result: { kind: "human" as const, inputId: queuedId },
    })),
  );
  h.render();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve plan")
      ?.click(),
  );
  expect(h.host.querySelector('[role="status"]')?.textContent).toContain(
    "Queued",
  );
  expect(h.host.textContent).not.toContain(queuedId);
  const source = h.snapshot.transitions[0];
  if (!source) throw new Error("missing transition fixture");
  h.snapshot.transitions.push({
    ...source,
    id: transitionId("applied-plan"),
    taskId: h.task.id,
    from: "plan_approval",
    to: "in_progress",
    trigger: { kind: "human", command: "approve_plan", inputId: queuedId },
    reason: "Human approved plan",
  });
  const { body, meta } = toSnapshot(h.snapshot);
  await act(async () => h.store.applyProtocol(stateFromSnapshot(meta, body)));
  expect(h.host.querySelector('[role="status"]')?.textContent).toContain(
    "Plan approval → In progress",
  );
  expect(h.host.textContent).not.toContain(queuedId);
});

test("tabs are Overview and Plan, with Terminal only while the issue has a live terminal", () => {
  const h = setup("plan");
  h.store.open(h.task.id);
  const tabs = () =>
    [...h.host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
  h.render();
  expect(tabs()).toEqual(["Overview", "Plan"]);
  // A selected Terminal tab with nothing to show falls back to Overview.
  act(() => h.store.setTab("terminal"));
  expect(
    h.host.querySelector("[data-tab-body]")?.getAttribute("data-tab-body"),
  ).toBe("overview");
  h.store.getState().panes = [{ ...pane, taskId: h.task.id }];
  h.render();
  expect(tabs()).toEqual(["Overview", "Plan", "Terminal"]);
  h.store.getState().panes = [{ ...pane, taskId: h.task.id, dead: true }];
  h.render();
  expect(tabs()).toEqual(["Overview", "Plan"]);
});

test("the overview renders the description and findings as Markdown and lists activity with its time", () => {
  const h = setup("plan");
  h.task.description = "Fix the **inbox** row.\n\n- first\n- second";
  h.snapshot.findings.push({
    id: "finding-md" as never,
    taskId: h.task.id,
    round: 1,
    source: "reviewer",
    externalId: null,
    createdByRunId: null,
    severity: "major",
    blocking: true,
    title: "Missing version",
    body: "Show `planVersion` in the row.",
    status: "escalate",
    reopenCount: 0,
    anchor: null,
    location: null,
    resolution: null,
    createdAt: h.snapshot.now,
    updatedAt: h.snapshot.now,
  });
  const source = h.snapshot.transitions[0];
  if (!source) throw new Error("missing transition fixture");
  h.snapshot.transitions.push({
    ...source,
    id: transitionId("overview-activity"),
    taskId: h.task.id,
    from: "planning",
    to: "plan_approval",
    reason: "Planner submitted valid plan",
  });
  h.store.open(h.task.id);
  h.render();
  const overview = h.host.querySelector(".issue-overview");
  expect(overview?.querySelector(".task-description strong")?.textContent).toBe(
    "inbox",
  );
  expect(overview?.querySelectorAll(".task-description li")).toHaveLength(2);
  expect(overview?.textContent).not.toContain("**inbox**");
  const finding = overview?.querySelector(".issue-finding");
  expect(finding?.textContent).toContain("Missing version");
  expect(finding?.querySelector("code")?.textContent).toBe("planVersion");
  // Each activity row keeps its time column, so its text isn't squeezed into the dot column.
  expect(overview?.querySelectorAll(".event").length).toBeGreaterThan(0);
  for (const row of overview?.querySelectorAll(".event") ?? [])
    expect(row.children).toHaveLength(3);
});
