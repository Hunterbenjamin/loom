import { repoKey } from "@loom/core";
import { expect, test } from "vitest";
import { leadBrief, mainPanelBrief, roleBrief, taskBrief } from "./prompts.js";

// Editorial guidance is reviewed with the prompts. These tests protect the data and tool
// names an agent needs, without treating a particular sentence as an executable contract.
test("Main receives the selected repository and a lossless saved note", () => {
  const note = 'Priority: releases.\n"Restart drill" is historical.';
  const repo = { github: "example/widgets", root: "/tmp/widgets" };
  const prompt = leadBrief(
    note,
    repo.github,
    "claude-test-model",
    repoKey(repo),
  );
  expect(prompt).toContain(repo.github);
  expect(prompt).toContain("WIDGETS-12");
  expect(prompt).not.toContain("LOOM-12");
  expectRepositoryGuidance(prompt);
  expect(prompt).toContain("Assisted-by: claude:claude-test-model");
  expect(prompt).toContain(JSON.stringify(note));
  for (const tool of [
    "list_tasks",
    "inspect_task",
    "create_task",
    "set_note",
    "message_agent",
  ])
    expect(prompt).toContain(tool);
  for (const tool of ["list_tasks", "inspect_task"])
    expect(mainPanelBrief()).toContain(tool);
});

test.each([
  ["planner", ["submit_plan", "ask_human"]],
  ["implementer", ["report_progress", "resolve_finding", "submit_for_review"]],
  ["reviewer", ["submit_review"]],
] as const)("%s receives its task identity and role tools", (role, tools) => {
  const prompt = roleBrief({
    task: {
      id: "t-example" as never,
      title: "Preserve the example",
      description: "Task details are read through context",
      reviewRound: 1,
      reviewRoundCap: 3,
    },
    role,
    provider: "codex",
    model: "gpt-6-astra",
    round: 1,
    branch: "fix/example",
    worktreePath: "/tmp/example-worktree",
  });
  for (const value of [
    role,
    "t-example",
    "Preserve the example",
    "fix/example",
    "/tmp/example-worktree",
    "get_task_context",
    ...tools,
  ])
    expect(prompt).toContain(value);
  expectRepositoryGuidance(prompt);
  expect(prompt).toContain("3-round review cap");
  expect(prompt).toContain("Call `get_task_context` first");
  if (role === "implementer") {
    expect(prompt).toContain(
      "Run only the test files that cover what you changed",
    );
    expect(prompt).toContain("no-check grace");
    expect(prompt).not.toContain("CI is the check");
    expect(prompt).toContain("fresh fix-round session");
    expect(prompt).toContain("reason, base-to-HEAD diff and blocking work");
    expect(prompt).toContain(
      "do not rely on an earlier implementer transcript",
    );
  }
  expect(prompt.includes("Assisted-by: codex:gpt-6-astra")).toBe(
    role === "implementer",
  );
});

test("task artifacts retain the human's title and description", () => {
  const brief = taskBrief({
    title: "Example",
    description: "  Keep this detail.\nAnd this line.  ",
  });
  expect(brief).toContain("Example");
  expect(brief).toContain("Keep this detail.\nAnd this line.");
});

function expectRepositoryGuidance(prompt: string) {
  for (const file of ["AGENTS.md", "CLAUDE.md", "WORKFLOW.md"])
    expect(prompt).toContain(file);
  for (const text of [
    "scripts/dev.sh",
    "Loom's principles",
    "Loom's architecture",
    "Loom's AGENTS.md",
  ])
    expect(prompt).not.toContain(text);
}
