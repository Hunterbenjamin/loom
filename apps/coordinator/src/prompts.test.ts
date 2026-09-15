import { expect, test } from "vitest";
import { leadBrief, mainPanelBrief, roleBrief, taskBrief } from "./prompts.js";

// Editorial guidance is reviewed with the prompts. These tests protect the data and tool
// names an agent needs, without treating a particular sentence as an executable contract.
test("Main receives the selected repository and a lossless saved note", () => {
  const note = 'Priority: releases.\n"Restart drill" is historical.';
  const prompt = leadBrief(note, "example/repository");
  expect(prompt).toContain("example/repository");
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
});

test("task artifacts retain the human's title and description", () => {
  const brief = taskBrief({
    title: "Example",
    description: "  Keep this detail.\nAnd this line.  ",
  });
  expect(brief).toContain("Example");
  expect(brief).toContain("Keep this detail.\nAnd this line.");
});
