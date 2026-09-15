import { expect, test } from "vitest";
import { leadBrief, mainPanelBrief, roleBrief } from "./prompts.js";

test("Main introduces itself in two sentences, waits, and has full access", () => {
  const prompt = leadBrief();
  expect(prompt).not.toMatch(/\bLead\b/);
  const introduction = prompt.match(
    /sentences, then end your turn and wait for the human: "([^"]+)"/,
  );
  expect(introduction?.[1]?.split(".").filter((s) => s.trim())).toHaveLength(2);
  expect(prompt).toContain("Make no tool calls before your introduction");
  expect(prompt).toContain("don't start work on your own");
  expect(prompt).toContain("restart drills");
  expect(prompt).toContain("the brain of this workspace, with hands");
  expect(prompt).toContain(
    "Create a Loom issue via create_task when the work is large",
  );
  expect(prompt).toContain("Don't poll or wait for an issue");
  expect(prompt).toContain(
    "merge only when the human tells you to in this conversation and CI is green, and don't push to a base branch",
  );
  expect(prompt).not.toContain("No shell");
});

test("Main reads its bounded memory as context, and panel summaries do not start work", () => {
  const note = 'Priority: releases.\n"Restart drill" is historical.';
  expect(leadBrief(note)).toContain(JSON.stringify(note));
  expect(leadBrief()).toContain("(no saved note)");
  expect(leadBrief(note)).toContain("set_note({note})");
  expect(leadBrief(note)).toContain("at most 2000 characters");
  expect(leadBrief(note)).toContain("context, not a request to act");
  expect(mainPanelBrief()).toContain("Needs-you");
  expect(mainPanelBrief()).toContain(
    "do not investigate, mutate issues or resolve anything",
  );
  expect(mainPanelBrief()).toContain("end your turn and wait");
});

test("Main messages never wait and have no Operator reply plumbing", () => {
  const prompt = leadBrief("", "example/repo");
  expect(prompt).toContain("Don't wait or poll for an answer");
  expect(prompt).toContain(
    "Use an issue, not a message, for anything that is work",
  );
  expect(prompt).not.toContain("Operator");
  expect(prompt).not.toContain("read_agent_replies");
  expect(mainPanelBrief()).not.toContain("read_agent_replies");
});

test("plans are short and record decisions; acceptance criteria are the bar implementers and reviewers hold", () => {
  const brief = (role: "planner" | "implementer" | "reviewer") =>
    roleBrief({
      task: {
        id: "t-1" as never,
        title: "Example",
        description: "",
        reviewRound: 1,
        reviewRoundCap: 3,
      },
      role,
      round: 1,
      branch: "loom/t-1",
      worktreePath: "/tmp/t-1",
    });
  expect(brief("planner")).toContain("about 300 to 600 words");
  expect(brief("planner")).toContain("Each step is one line naming an outcome");
  expect(brief("planner")).toContain("Loom rejects plans over 800 words");
  expect(brief("planner")).toContain("at most eight acceptance criteria");
  expect(brief("planner")).toContain("don't add requirements beyond it");
  expect(brief("implementer")).toContain("acceptance criteria are the bar");
  expect(brief("planner")).toContain(
    "the fix must remove that cause, not hide it",
  );
  expect(brief("implementer")).toContain("Fix causes, not symptoms");
  expect(brief("reviewer")).toContain(
    "a fix that hides a bug instead of removing its cause, or a second definition",
  );
  expect(brief("reviewer")).toContain("an unmet acceptance criterion");
  expect(brief("reviewer")).toContain("The rest of the plan is guidance");
  expect(brief("reviewer")).not.toContain("AGENTS.md, and judge");
  expect(leadBrief()).toContain(
    "never add requirements the human did not ask for",
  );
  expect(leadBrief()).toContain(
    "Group work by the review question and the files it touches, not one issue per finding",
  );
});
