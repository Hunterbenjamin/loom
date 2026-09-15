import type { TaskId } from "@loom/core";
import type { Store } from "@loom/store";
import { expect, test, vi } from "vitest";
import { Loop } from "./loop.js";

test("provider hints cannot starve queued executor actions", async () => {
  const taskId = "busy-task" as TaskId;
  let executed = false;
  const drainExecutor = vi.fn(async () => {
    if (executed) return 0;
    executed = true;
    // An action receipt must also receive a reconcile pass.
    loop.enqueue(taskId);
    return 1;
  });
  const loop = new Loop({
    store: {} as Store,
    observe: vi.fn(),
    rebase: vi.fn(),
    drainExecutor,
    onCommit: vi.fn(),
    onError: vi.fn(),
    maxCycles: 5,
  });
  const passes: boolean[] = [];
  vi.spyOn(loop, "pass").mockImplementation(async (id) => {
    passes.push(executed);
    // A busy provider keeps enqueueing while an approval or launch waits.
    if (!executed) loop.enqueue(id);
    return { taskId: id, result: null, version: null, conflicts: 0 };
  });
  loop.enqueue(taskId);

  await expect(loop.settle()).resolves.toBeUndefined();
  expect(passes).toEqual([false, true]);
  expect(drainExecutor).toHaveBeenCalledTimes(2);
  expect(loop.queued).toBe(0);
});
