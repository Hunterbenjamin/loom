import type { CodexAdapter, TaskId } from "@loom/core";
import { expect, test, vi } from "vitest";
import { codexPerTask } from "./adapters.js";

test("a stopped task server is forgotten, so the count is honest and a later use starts a fresh one", async () => {
  const made: CodexAdapter[] = [];
  const codex = codexPerTask("/data", () => {
    const adapter = {
      startServer: vi.fn(async () => {}),
      stopServer: vi.fn(async () => {}),
    } as unknown as CodexAdapter;
    made.push(adapter);
    return adapter;
  });
  const task = "t-1" as TaskId;
  const first = await codex.codex(task);
  expect(await codex.codex(task)).toBe(first);
  expect(codex.codexServerCount()).toBe(1);
  await codex.stopCodexServer(task);
  expect(first.stopServer).toHaveBeenCalledOnce();
  expect(codex.codexServerCount()).toBe(0);
  const second = await codex.codex(task);
  expect(second).not.toBe(first);
  expect(second.startServer).toHaveBeenCalledOnce();
  expect(made).toHaveLength(2);
});
