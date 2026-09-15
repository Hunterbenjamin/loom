import type { AttentionReason } from "@loom/core";
import { describe, expect, test } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { issueDecisions } from "./issue-actions.js";
import { createStore } from "./store.js";

function setup(reason?: AttentionReason) {
  const snapshot = buildSnapshot(8);
  const task = snapshot.tasks[0];
  if (!task) throw new Error("missing fixture task");
  task.attention = reason
    ? {
        reasons: [reason],
        reasonSince: { [reason]: snapshot.now },
        since: snapshot.now,
      }
    : { reasons: [], reasonSince: {}, since: null };
  const store = createStore(snapshot, "dev");
  store.setConnection("connected");
  return { snapshot, task, store };
}

describe("issueDecisions", () => {
  test.each([
    ["plan_needs_approval", ["Approve plan", "Change plan"]],
    ["needs_approval", ["Approve merge", "Request changes"]],
    ["question", ["Answer question"]],
    ["failed", ["Retry", "Open terminal"]],
  ] as const)("derives %s from task state", (reason, labels) => {
    const h = setup(reason);
    if (reason === "plan_needs_approval") {
      h.task.stage = "plan_approval";
      h.snapshot.plans[h.task.id] = {
        goal: "Ship it",
        nonGoals: [],
        steps: [],
        areas: [],
        acceptanceCriteria: [],
        testPlan: [],
        risks: [],
        openQuestions: [],
        suggestedImplementer: null,
        version: 7,
      };
    }
    if (reason === "needs_approval") {
      h.task.stage = "awaiting_approval";
      h.store.getState().inbox = [
        {
          taskId: h.task.id,
          reasonRuns: {},
          reviewedHead: "a".repeat(40) as never,
          planVersion: null,
          workTime: { startedAt: null, readyAt: null },
        },
      ];
    }
    expect(
      issueDecisions(h.store.getState(), h.task).decisions[0]?.actions.map(
        (action) => action.label,
      ),
    ).toEqual(labels);
  });

  test("falls back to the projected plan version and ignores navigation state", () => {
    const h = setup("plan_needs_approval");
    h.task.stage = "plan_approval";
    h.snapshot.plans[h.task.id] = {
      goal: "Goal",
      nonGoals: [],
      steps: [],
      areas: [],
      acceptanceCriteria: [],
      testPlan: [],
      risks: [],
      openQuestions: [],
      suggestedImplementer: null,
      version: 12,
    };
    const before = issueDecisions(h.store.getState(), h.task);
    h.store.openAttention(h.task.id, "plan_needs_approval", "plan", null);
    const after = issueDecisions(h.store.getState(), h.task);
    expect(before.decisions[0]?.planVersion).toBe(12);
    expect(before.decisions[0]?.planGoal).toBe("Goal");
    expect(before.decisions[0]?.actions[1]?.command?.("Revise it")).toEqual({
      type: "reject_plan",
      feedback: "Revise it",
    });
    expect(after).toBe(before);
  });

  test("guards plan changes with coordinator and current plan state", () => {
    const wrongStage = setup("plan_needs_approval");
    expect(
      issueDecisions(wrongStage.store.getState(), wrongStage.task).decisions[0]
        ?.actions[1]?.disabledReason,
    ).toBe("Plan changes are only available in Plan approval");

    const disconnected = setup("plan_needs_approval");
    disconnected.task.stage = "plan_approval";
    disconnected.store.setConnection("disconnected");
    expect(
      issueDecisions(disconnected.store.getState(), disconnected.task)
        .decisions[0]?.actions[1]?.disabledReason,
    ).toContain("Connect to the coordinator");

    const missingVersion = setup("plan_needs_approval");
    missingVersion.task.stage = "plan_approval";
    expect(
      issueDecisions(missingVersion.store.getState(), missingVersion.task)
        .decisions[0]?.actions[1]?.disabledReason,
    ).toBe("The latest plan version is unavailable");
  });

  test("derives provider requests and pane prompts from runs with pinned commands", () => {
    const h = setup();
    const run = h.snapshot.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.taskId = h.task.id;
    run.endedAt = null;
    run.pendingRequests = [
      {
        id: "request-1",
        generation: 4,
        kind: "permission",
        blocking: true,
        summary: "Use the network",
        receivedAt: h.snapshot.now,
      },
    ];
    run.pendingDialog = {
      requestId: "dialog-1",
      command: "pnpm test",
      kind: "permission",
      tool: "Bash",
      at: h.snapshot.now,
    };
    const result = issueDecisions(h.store.getState(), h.task);
    expect(result.decisions.map((decision) => decision.kind)).toEqual([
      "provider_request",
      "pane_prompt",
    ]);
    expect(result.decisions[0]?.actions[0]?.command?.()).toMatchObject({
      type: "answer_provider_request",
      requestId: "request-1",
      generation: 4,
    });
    expect(result.decisions[1]?.actions[1]?.command?.()).toMatchObject({
      type: "answer_pane_prompt",
      expectedDialog: {
        requestId: "dialog-1",
        command: "pnpm test",
        sessionEpoch: run.sessionEpoch,
      },
    });
  });

  test("shows cheap guard reasons and secondary status actions", () => {
    const h = setup("failed");
    h.task.blocked = {
      reason: "dependencies",
      since: h.snapshot.now,
      detail: "Waiting",
      until: null,
      questionId: null,
    };
    expect(
      issueDecisions(h.store.getState(), h.task).decisions[0]?.actions[0]
        ?.disabledReason,
    ).toBe("Resolve the blocked reason before retrying");
    h.store.setConnection("disconnected");
    expect(
      issueDecisions(h.store.getState(), h.task).decisions[0]?.actions[0]
        ?.disabledReason,
    ).toContain("Connect");
    h.task.attention = { reasons: [], reasonSince: {}, since: null };
    expect(
      issueDecisions(h.store.getState(), h.task).status.secondaryActions.map(
        (action) => action.label,
      ),
    ).toContain("Cancel issue");
  });
});
