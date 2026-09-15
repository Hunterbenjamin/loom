import { expect, test } from "vitest";
import type { IsoTime } from "./ids.js";
import { workTime } from "./work-time.js";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 8, 15, 10, minute)).toISOString() as IsoTime;
const move = (minute: number, from: string, to: string) =>
  ({ at: at(minute), from, to }) as never;

test("work runs from the first In progress to the latest entry into Awaiting approval", () => {
  const transitions = [
    move(0, "backlog", "todo"),
    move(1, "todo", "planning"),
    move(5, "plan_approval", "in_progress"),
    move(20, "in_review", "awaiting_approval"),
    // Main moved and the branch conflicted: back to work, ready again later.
    move(25, "awaiting_approval", "in_progress"),
    move(40, "in_review", "awaiting_approval"),
    move(45, "merging", "done"),
  ];
  expect(workTime(transitions, "done")).toEqual({
    startedAt: at(5),
    readyAt: at(40),
  });
});

test("an issue still being worked on has a start and no end", () => {
  const transitions = [
    move(5, "todo", "in_progress"),
    move(20, "in_review", "awaiting_approval"),
    move(25, "awaiting_approval", "in_progress"),
  ];
  expect(workTime(transitions, "in_progress")).toEqual({
    startedAt: at(5),
    readyAt: null,
  });
});

test("no In progress means no work time; a GitHub merge without approval ends at Done", () => {
  expect(workTime([move(0, "backlog", "todo")], "todo")).toEqual({
    startedAt: null,
    readyAt: null,
  });
  expect(
    workTime(
      [move(5, "todo", "in_progress"), move(30, "in_review", "done")],
      "done",
    ),
  ).toEqual({ startedAt: at(5), readyAt: at(30) });
});
