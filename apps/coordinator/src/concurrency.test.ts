// Tasks don't wait for each other (design §5.1): one task's slow action or owner read holds up
// neither another task's pass nor its actions, and a human move is decided before any of them.

import type { TaskId } from "@loom/core";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

/** Real git runs underneath, so give each wait room on a busy machine. */
const WAIT = { timeout: 10_000 };

let h: Harness;
afterEach(async () => {
  h?.coordinator.loop.stop();
  await h?.close();
});

test("a task's slow worktree setup holds up neither another task's move nor its worktree", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slow: TaskId | null = null;
  h = await createHarness({
    files: { "WORKFLOW.md": "## setup\n```sh\npnpm install\n```\n" },
    shell: async (_command, cwd) => {
      if (slow && cwd.includes(slow)) await held;
    },
  });
  const create = (title: string) =>
    h.coordinator.createTask({
      repoId: h.repo.id,
      title,
      description: title,
      size: "small",
    }).task.id;
  slow = create("Slow setup");
  const other = create("Other");
  h.coordinator.loop.start();
  await vi.waitFor(
    () => expect(h.coordinator.confirmed(other)).toBe(true),
    WAIT,
  );

  h.coordinator.submitHuman(slow, { type: "move", to: "todo" });
  await vi.waitFor(
    () =>
      expect(
        h.shellCalls.some((call) => call.cwd.includes(slow as string)),
      ).toBe(true),
    WAIT,
  );

  // Decided on the spot, from the readings of the pass above: no owner read in between.
  h.coordinator.submitHuman(other, { type: "move", to: "todo" });
  expect(h.store.loadTaskState(other).task.stage).not.toBe("backlog");
  expect(h.coordinator.confirmed(other)).toBe(false);
  await vi.waitFor(
    () =>
      expect(h.shellCalls.some((call) => call.cwd.includes(other))).toBe(true),
    WAIT,
  );
  expect(h.store.loadTaskState(slow).worktree?.createdAt ?? null).toBeNull();

  release();
  h.coordinator.loop.stop();
  await h.coordinator.settle();
  expect(h.store.loadTaskState(slow).worktree).not.toBeNull();
}, 30_000);

test("a refusal waits for fresh readings instead of being decided from the last ones", async () => {
  h = await createHarness();
  const { task } = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Refused",
    description: "Refused",
    size: "small",
  });
  await h.coordinator.settle();
  const approve = h.coordinator.submitHuman(task.id, {
    type: "approve_plan",
    planVersion: 1,
  });
  expect(h.store.inputDisposition(task.id, approve)).toBeNull();
  await h.coordinator.settle();
  expect(h.store.inputDisposition(task.id, approve)).toMatchObject({
    accepted: false,
    error: { code: "wrong_stage" },
  });
}, 30_000);
