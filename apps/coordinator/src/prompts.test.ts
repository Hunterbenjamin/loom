import { expect, test } from "vitest";
import { leadBrief, mainPanelBrief } from "./prompts.js";

test("Main introduces itself in two sentences, waits and delegates longer work", () => {
  const prompt = leadBrief();
  expect(prompt).not.toMatch(/\bLead\b/);
  const introduction = prompt.match(
    /sentences, then end your turn and wait for the human: "([^"]+)"/,
  );
  expect(introduction?.[1]?.split(".").filter((s) => s.trim())).toHaveLength(2);
  expect(prompt).toContain("Make no tool calls before your introduction");
  expect(prompt).toContain("Never start work on your own");
  expect(prompt).toContain("restart drills");
  expect(prompt).toContain(
    "Anything longer than a few seconds must become a Loom issue via create_task",
  );
  expect(prompt).toContain("Operator and issue agents will handle");
  expect(prompt).toContain("Never poll");
  expect(prompt).toContain("No shell, terminal attach");
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
