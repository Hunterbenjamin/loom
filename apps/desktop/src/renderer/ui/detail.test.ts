// @vitest-environment happy-dom

import { stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { inputId, questionId, transitionId } from "../fixtures/ids.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { buildPullRequestDetails } from "../fixtures/pull-requests.js";
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
  kind: "plan" | "merge" | "question" | "failed" | "provider" | "ci" = "plan",
) {
  const snapshot = buildSnapshot(8);
  const task = snapshot.tasks[0];
  if (!task) throw new Error("missing task");
  task.stage =
    kind === "plan"
      ? "plan_approval"
      : kind === "merge"
        ? "awaiting_approval"
        : kind === "ci"
          ? "ci"
          : "in_progress";
  const reason = {
    plan: "plan_needs_approval",
    merge: "needs_approval",
    question: "question",
    failed: "failed",
    provider: "provider_permission",
  } as const;
  task.attention =
    kind === "ci"
      ? { reasons: [], reasonSince: {}, since: null }
      : {
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
      ci:
        kind === "ci"
          ? {
              headSha: "a".repeat(40) as never,
              since: snapshot.now,
              conclusion: "pending",
              checks: [
                {
                  name: "lint-typecheck-test",
                  status: "in_progress",
                  conclusion: null,
                  url: "https://github.com/example/repo/actions/runs/1",
                },
              ],
              observedAt: snapshot.now,
            }
          : null,
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

test("CI detail shows the submitted head and linked check status", () => {
  const h = setup("ci");
  h.render();
  const ci = h.host.querySelector('[data-testid="ci-status"]');
  expect(ci?.textContent).toContain("Commit aaaaaaa");
  expect(ci?.textContent).toContain("lint-typecheck-test");
  expect(ci?.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/example/repo/actions/runs/1",
  );
});

test("issue detail shows compact per-run and issue token totals", () => {
  const h = setup("plan");
  const runs = h.snapshot.runs.slice(0, 2);
  for (const run of runs) run.taskId = h.task.id;
  if (!runs[0] || !runs[1]) throw new Error("missing usage runs");
  runs[0].tokenUsage = [
    {
      sessionId: "usage-a" as never,
      counts: {
        input: 12_000,
        cachedInput: 4_000,
        output: 3_000,
        reasoning: 1_000,
      },
      observedAt: h.snapshot.now,
    },
  ];
  runs[1].tokenUsage = [
    {
      sessionId: "usage-b" as never,
      counts: {
        input: 500,
        cachedInput: 100,
        output: 200,
        reasoning: 50,
      },
      observedAt: h.snapshot.now,
    },
  ];
  h.render();
  expect(
    h.host.querySelector("[data-testid=issue-token-usage]")?.textContent,
  ).toContain("12.5K in · 4.1K cached · 3.2K out · 1.1K reasoning");
  expect(
    [...h.host.querySelectorAll("[data-testid=run-token-usage]")].map(
      (node) => node.textContent,
    ),
  ).toEqual([
    "Tokens · 12K in · 4K cached · 3K out · 1K reasoning",
    "Tokens · 500 in · 100 cached · 200 out · 50 reasoning",
  ]);
});

test("plan approval opened from the Issues list shows only the header actions", () => {
  const h = setup("plan");
  h.store.open(h.task.id);
  h.render();
  expect(h.host.querySelector(".issue-decision-panel")).toBeNull();
  expect(
    [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-toolbar-action button",
      ),
    ].map((button) => `${button.textContent}:${button.disabled}`),
  ).toEqual(["Change plan:false", "Approve plan:false"]);
  // Change plan is the quiet secondary action; Approve plan stays primary on the right.
  expect(
    h.host.querySelector(".issue-toolbar-action button")?.className,
  ).toContain("secondary");
});

test("Change plan requires feedback and sends the trimmed request", async () => {
  const h = setup("plan");
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: inputId("change-plan") },
  }));
  h.store.setSender(sender);
  h.render();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Change plan")
      ?.click(),
  );
  const dialog = h.host.querySelector<HTMLDialogElement>(".pr-confirm");
  expect(dialog?.textContent).toContain("Plan version 9");
  expect(dialog?.textContent).toContain("A clear plan");
  const sendButton = [
    ...h.host.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Send to planner");
  expect(sendButton?.disabled).toBe(true);
  const draft = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Requested changes"]',
  );
  if (!draft) throw new Error("missing requested changes field");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(draft, "   ");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(sendButton?.disabled).toBe(true);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(draft, "  Clarify the test strategy  ");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(sendButton?.disabled).toBe(false);
  await act(async () => sendButton?.click());
  expect(sender).toHaveBeenCalledExactlyOnceWith({
    kind: "human",
    taskId: h.task.id,
    command: {
      type: "reject_plan",
      feedback: "Clarify the test strategy",
    },
  });
  // Progress shows on the Change plan button itself, not as status text.
  const changeButton = [
    ...h.host.querySelectorAll<HTMLButtonElement>(
      ".issue-toolbar-action button",
    ),
  ].find((button) => button.textContent === "Change plan");
  expect(changeButton?.getAttribute("aria-busy")).toBe("true");
  expect(changeButton?.querySelector(".button-spinner")).not.toBeNull();
  expect(h.host.querySelector(".issue-toolbar-action .pr-outcome")).toBeNull();
});

test("canceling Change plan preserves its draft without sending", async () => {
  const h = setup("plan");
  const sender = vi.fn();
  h.store.setSender(sender);
  h.render();
  const open = () =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Change plan",
    );
  await act(async () => open()?.click());
  const draft = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Requested changes"]',
  );
  if (!draft) throw new Error("missing requested changes field");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(draft, "Keep this draft");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")
      ?.click(),
  );
  expect(sender).not.toHaveBeenCalled();
  expect(h.host.querySelector('[aria-label="Requested changes"]')).toBeNull();
  await act(async () => open()?.click());
  expect(
    h.host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Requested changes"]',
    )?.value,
  ).toBe("Keep this draft");
  act(() => {
    h.host
      .querySelector<HTMLDialogElement>(".pr-confirm")
      ?.dispatchEvent(
        new Event("cancel", { bubbles: false, cancelable: true }),
      );
  });
  expect(h.host.querySelector('[aria-label="Requested changes"]')).toBeNull();
  expect(sender).not.toHaveBeenCalled();
});

test("a refused Change plan request keeps its draft", async () => {
  const h = setup("plan");
  h.store.setSender(
    vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "guard_failed" as const,
        message: "Plan changed",
        details: [],
      },
    })),
  );
  h.render();
  const open = () =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Change plan",
    );
  await act(async () => open()?.click());
  const draft = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Requested changes"]',
  );
  if (!draft) throw new Error("missing requested changes field");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(draft, "Preserve this");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Send to planner")
      ?.click(),
  );
  await act(async () => open()?.click());
  expect(
    h.host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Requested changes"]',
    )?.value,
  ).toBe("Preserve this");
});

test("plan actions expose coordinator availability once in the header", () => {
  const h = setup("plan");
  h.store.setConnection("disconnected");
  h.render();
  const buttons = [
    ...h.host.querySelectorAll<HTMLButtonElement>(
      ".issue-toolbar-action button",
    ),
  ];
  expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
  expect(h.host.querySelector(".issue-toolbar-action")?.textContent).toContain(
    "Connect to the coordinator",
  );
  expect(
    h.host.querySelectorAll(".issue-toolbar-action .disabled-reason"),
  ).toHaveLength(1);
});

test("Change plan refuses a plan version that changed while the modal was open", async () => {
  const h = setup("plan");
  h.render();
  await act(async () =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Change plan")
      ?.click(),
  );
  h.store.getState().inbox = [
    {
      taskId: h.task.id,
      reasonRuns: {},
      reviewedHead: null,
      planVersion: 10,
    },
  ];
  await act(async () => {
    h.store.setConnection("disconnected");
    h.store.setConnection("connected");
  });
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain(
    "plan changed to version 10",
  );
  expect(
    [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Send to planner",
    )?.disabled,
  ).toBe(true);
});

test("merge approval actions stay disabled with the coordinator's reason while disconnected", () => {
  const h = setup("merge");
  h.store.setConnection("disconnected");
  h.render();
  const buttons = [
    ...h.host.querySelectorAll<HTMLButtonElement>(
      ".issue-toolbar-action button",
    ),
  ];
  expect(
    buttons.map((button) => `${button.textContent}:${button.disabled}`),
  ).toEqual(["Request changes:true", "Approve merge:true"]);
  expect(h.host.querySelector(".issue-toolbar-action")?.textContent).toContain(
    "Connect to the coordinator",
  );
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
        ".issue-decision-actions button, .issue-toolbar-action button",
      ),
    ].map((button) => `${button.textContent}:${button.disabled}`);
    act(() => h.store.open(h.task.id));
    const list = [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-decision-actions button, .issue-toolbar-action button",
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
        ".issue-decision-actions button, .issue-toolbar-action button",
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
  const refusal = h.host.querySelector('.issue-toolbar-action [role="alert"]');
  expect(refusal?.textContent).toContain("guard_failed: Head changed");
  expect(refusal?.textContent).toContain("Review the latest head");
});

test("merge approval lives in the header: Request changes left and quiet, Approve merge right and confirmed", async () => {
  const h = setup("merge");
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: inputId("confirmed-merge") },
  }));
  h.store.setSender(sender);
  h.render();
  expect(h.host.querySelector(".issue-decision-panel")).toBeNull();
  const buttons = [
    ...h.host.querySelectorAll<HTMLButtonElement>(
      ".issue-toolbar-action button",
    ),
  ];
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Request changes",
    "Approve merge",
  ]);
  expect(buttons[0]?.className).toContain("secondary");
  await act(async () => buttons[1]?.click());
  expect(h.host.querySelectorAll(".pr-confirm")).toHaveLength(1);
  expect(sender).not.toHaveBeenCalled();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel")
      ?.click(),
  );
  expect(h.host.querySelector(".pr-confirm")).toBeNull();
});

test("Request changes asks for feedback in a dialog and sends it to the implementer", async () => {
  const h = setup("merge");
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: inputId("request-changes") },
  }));
  h.store.setSender(sender);
  h.render();
  const button = (text: string) =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === text,
    );
  await act(async () => button("Request changes")?.click());
  const dialog = h.host.querySelector(".pr-confirm");
  expect(dialog?.textContent).toContain("Request changes");
  expect(dialog?.textContent).toContain("b".repeat(7));
  expect(button("Send to implementer")?.disabled).toBe(true);
  const textarea = h.host.querySelector<HTMLTextAreaElement>(
    '[aria-label="Requested changes"]',
  );
  if (!textarea) throw new Error("missing feedback field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, "  Handle the empty list  ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send to implementer")?.click());
  expect(sender).toHaveBeenCalledOnce();
  const sent = (sender.mock.calls[0] as unknown[] | undefined)?.[0] as {
    command: { type: string; findings: { body: string }[] };
  };
  expect(sent.command.type).toBe("request_changes");
  expect(sent.command.findings[0]?.body).toBe("Handle the empty list");
  expect(
    [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-toolbar-action button",
      ),
    ]
      .find((item) => item.textContent === "Request changes")
      ?.getAttribute("aria-busy"),
  ).toBe("true");
});

test("merge confirmation refuses a reviewed head that changed while open", async () => {
  const h = setup("merge");
  h.render();
  await act(async () =>
    [
      ...h.host.querySelectorAll<HTMLButtonElement>(
        ".issue-toolbar-action button",
      ),
    ]
      .find((button) => button.textContent === "Approve merge")
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

test("an approved plan shows a loading button until its transition applies, without status text or the input id", async () => {
  const h = setup("plan");
  const queuedId = inputId("hidden-command-id");
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: queuedId },
  }));
  h.store.setSender(sender);
  h.render();
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve plan")
      ?.click(),
  );
  expect(sender).toHaveBeenCalledExactlyOnceWith({
    kind: "human",
    taskId: h.task.id,
    command: { type: "approve_plan", planVersion: 9 },
  });
  // While queued, the clicked button shows a spinner and both actions wait; no status text.
  const buttons = () => [
    ...h.host.querySelectorAll<HTMLButtonElement>(
      ".issue-toolbar-action button",
    ),
  ];
  const approve = buttons().find((b) => b.textContent === "Approve plan");
  expect(approve?.getAttribute("aria-busy")).toBe("true");
  expect(approve?.querySelector(".button-spinner")).not.toBeNull();
  expect(buttons().every((b) => b.disabled)).toBe(true);
  expect(
    buttons()
      .find((b) => b.textContent === "Change plan")
      ?.getAttribute("aria-busy"),
  ).toBeNull();
  expect(h.host.querySelector(".issue-toolbar-action .pr-outcome")).toBeNull();
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
  // Applied: the plan is no longer awaiting approval, so nothing is left spinning.
  expect(h.host.querySelector('[aria-busy="true"]')).toBeNull();
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
  // This test checks tab availability; terminal rendering has its own tests.
  act(() => h.store.setTab("overview"));
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

test("backlog exposes editing and Move to Todo; absent plan and branch omit their tabs", async () => {
  const h = setup();
  h.task.stage = "backlog";
  h.task.attention = { reasons: [], reasonSince: {}, since: null };
  h.task.branch = null;
  h.task.prNumber = null;
  delete h.snapshot.plans[h.task.id];
  h.snapshot.pullRequests = [];
  const sender = vi.fn(async () => ({
    ok: true as const,
    result: { kind: "human" as const, inputId: inputId("backlog-move") },
  }));
  h.store.setSender(sender);
  h.render();
  expect(
    [...h.host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
  ).toEqual(["Overview"]);
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((b) => b.textContent === "Edit issue")
      ?.click(),
  );
  const title = h.host.querySelector<HTMLInputElement>('[aria-label="Title"]');
  if (!title) throw new Error("Missing title field");
  expect(title.value).toBe(h.task.title);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(title, "New backlog title");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((b) => b.textContent === "Save changes")
      ?.click(),
  );
  expect(sender).toHaveBeenLastCalledWith({
    kind: "human",
    taskId: h.task.id,
    command: {
      type: "edit_task",
      expectedVersion: h.task.version,
      title: "New backlog title",
      description: h.task.description,
      size: h.task.size,
      requirePlanApproval: h.task.requirePlanApproval,
    },
  });
  await act(async () =>
    [...h.host.querySelectorAll("button")]
      .find((b) => b.textContent === "Move to Todo")
      ?.click(),
  );
  expect(sender).toHaveBeenLastCalledWith({
    kind: "human",
    taskId: h.task.id,
    command: { type: "move", to: "todo" },
  });
});

test("a PR head change disables issue approval and invalidates its open confirmation", async () => {
  const h = setup("merge");
  const row = buildPullRequestDetails(h.snapshot.pullRequests)[0];
  if (!row) throw new Error("Missing PR");
  row.repoId = h.task.repoId;
  row.taskId = h.task.id;
  h.task.prNumber = row.number;
  row.detail.headSha = "b".repeat(40) as typeof row.detail.headSha;
  h.store.getState().pullRequestDetails = [row];
  h.render();
  const button = (label: string) =>
    [...h.host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === label,
    );
  expect(button("Approve merge")?.disabled).toBe(false);
  await act(async () => button("Approve merge")?.click());
  expect(button("Confirm approval")?.disabled).toBe(false);
  act(() => {
    row.detail.headSha = "c".repeat(40) as typeof row.detail.headSha;
    h.render();
  });
  expect(button("Confirm approval")?.disabled).toBe(true);
  expect(button("Approve merge")?.disabled).toBe(true);
});
