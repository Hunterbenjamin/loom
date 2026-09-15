import { describe, expect, test } from "vitest";
import { base, finding, fixture, head, now } from "../test/fixtures.js";
import type { QuestionId, TestResult } from "./index.js";
import { taskContextChanges, taskContextFull } from "./task-context.js";

const full = (
  state = fixture().state,
  role: "implementer" | "reviewer" = "implementer",
) => {
  const run = state.runs.find((candidate) => candidate.role === role);
  if (!run) throw new Error("Missing fixture run");
  return taskContextFull({
    state,
    runId: run.id,
    headSha: head,
    brief: "Brief",
    workflow: { test: "pnpm test" },
  });
};

describe("task context projection", () => {
  test("a no-change diff contains only its header and must-act list", () => {
    const current = full();
    expect(taskContextChanges(current, current)).toEqual({
      view: "changes",
      header: {
        task: { stage: "in_progress", reviewRound: 1 },
        run: current.run,
        worktree: {
          baseSha: base,
          headSha: head,
          roundHead: head,
          lastReviewedHead: head,
        },
      },
      mustAct: [],
    });
  });

  test("returns appended decisions and test results, or the rewritten whole", () => {
    const state = fixture().state;
    state.artifactContents.decisions = "First\n";
    const previous = full(state);
    const result: TestResult = {
      command: "pnpm test",
      outcome: "passed",
      summary: "Passed",
      headSha: head,
      ranAt: now,
      runId: previous.run.id,
    };
    state.artifactContents.decisions = "First\nSecond\n";
    state.artifactContents.test_results = [result];
    expect(taskContextChanges(previous, full(state))).toMatchObject({
      decisions: "Second\n",
      testResults: [result],
    });

    const rewritten = full(state);
    state.artifactContents.decisions = "Replacement\n";
    state.artifactContents.test_results = [{ ...result, summary: "Updated" }];
    expect(taskContextChanges(rewritten, full(state))).toMatchObject({
      decisions: "Replacement\n",
      testResults: [{ summary: "Updated" }],
    });
  });

  test("returns a changed plan and newly answered questions", () => {
    const state = fixture().state;
    const previous = full(state);
    if (!state.plan) throw new Error("Missing fixture plan");
    state.plan.version++;
    state.questions.push({
      id: "q1" as QuestionId,
      taskId: state.task.id,
      runId: previous.run.id,
      question: "Proceed?",
      options: [],
      blocking: false,
      askedAt: now,
      answer: "Yes",
      answeredAt: now,
    });
    expect(taskContextChanges(previous, full(state))).toMatchObject({
      plan: { version: 2 },
      answeredQuestions: [{ id: "q1", question: "Proceed?", answer: "Yes" }],
    });
  });

  test("returns new and changed findings plus IDs no longer visible", () => {
    const state = fixture().state;
    state.findings = [finding("changed"), finding("hidden")];
    const previous = full(state);
    state.findings = [
      finding("changed", { body: "New details" }),
      finding("hidden", { status: "resolved" }),
      finding("added"),
    ];
    expect(taskContextChanges(previous, full(state)).findings).toEqual({
      changed: [
        expect.objectContaining({ id: "changed", body: "New details" }),
        expect.objectContaining({ id: "added" }),
      ],
      noLongerVisible: ["hidden"],
    });
  });

  test("must-act lists are role-specific and never bypass visibility", () => {
    const state = fixture().state;
    state.findings = [
      finding("implement", { status: "escalate" }),
      finding("nonblocking", { blocking: false }),
      finding("verdict", { status: "addressed", source: "human" }),
      finding("hidden-reviewer", { status: "addressed", source: "reviewer" }),
    ];
    const implementer = full(state);
    expect(taskContextChanges(implementer, implementer).mustAct).toEqual([
      { id: "implement", title: "Fix bug", status: "escalate" },
    ]);

    const reviewer = full(state, "reviewer");
    expect(reviewer.findings.map((item) => item.id)).not.toContain(
      "hidden-reviewer",
    );
    expect(taskContextChanges(reviewer, reviewer).mustAct).toEqual([
      { id: "verdict", title: "Fix bug", status: "addressed" },
    ]);
  });
});
