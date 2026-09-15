import { expect, test } from "vitest";
import { command, fixture } from "../test/fixtures.js";
import { reconcile } from "./index.js";

const fields = {
  title: "Updated title",
  description: "Updated description",
  size: "small" as const,
  requirePlanApproval: false,
};
test("backlog fields change together, retain identity, and increment the task version", () => {
  const f = fixture("backlog");
  f.observations.inputs = [
    command({
      type: "edit_task",
      expectedVersion: f.state.task.version,
      ...fields,
    }),
  ];
  const result = reconcile(f.state, f.observations);
  expect(result.inputs[0]?.accepted).toBe(true);
  expect(result.next.task).toMatchObject({
    ...fields,
    id: f.state.task.id,
    stage: "backlog",
    name: f.state.task.name,
  });
  expect(result.next.task.version).toBe(f.state.task.version + 1);
});
test.each([
  "todo",
  "planning",
  "in_progress",
  "awaiting_approval",
  "done",
] as const)("editing is refused in %s", (stage) => {
  const f = fixture(stage);
  f.observations.inputs = [
    command({
      type: "edit_task",
      expectedVersion: f.state.task.version,
      ...fields,
    }),
  ];
  const result = reconcile(f.state, f.observations);
  expect(result.inputs[0]).toMatchObject({
    accepted: false,
    error: { code: "wrong_stage" },
  });
  expect(result.next.task.title).toBe(f.state.task.title);
});
test("a stale editor cannot overwrite another edit", () => {
  const f = fixture("backlog");
  f.observations.inputs = [
    command({
      type: "edit_task",
      expectedVersion: f.state.task.version + 1,
      ...fields,
    }),
  ];
  const result = reconcile(f.state, f.observations);
  expect(result.inputs[0]).toMatchObject({
    accepted: false,
    error: { code: "guard_failed" },
  });
  expect(result.next.task.title).toBe(f.state.task.title);
});
