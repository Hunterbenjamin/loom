import type { ProviderSessionId, WorktreePath } from "@loom/core";
import { expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  options: null as unknown,
  result: { type: "result", subtype: "success", errors: [] as string[] },
  close: vi.fn(),
  interrupt: vi.fn(),
  release: () => {},
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionInfo: vi.fn(),
  query: ({ options }: { options: unknown }) => {
    fake.options = options;
    return {
      close: fake.close,
      interrupt: fake.interrupt,
      async *[Symbol.asyncIterator]() {
        yield fake.result;
        await new Promise<void>((resolve) => {
          fake.release = resolve;
        });
      },
    };
  },
}));

import { HeadlessRun } from "./headless.js";

test("native result is a turn receipt, not child exit", async () => {
  const run = new HeadlessRun(
    {
      sessionId: "00000000-0000-4000-8000-000000000000" as ProviderSessionId,
      cwd: "/tmp/loom-test-headless" as WorktreePath,
      model: "fake",
      settingsPath: "/tmp/loom-test-headless/settings.json",
      readOnly: true,
      resume: false,
      prompt: "event",
    },
    { loom: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  );
  await vi.waitFor(() => expect(run.state.completedTurns).toBe(1));
  expect(run.state.exited).toBe(false);
  run.close();
  expect(fake.close).toHaveBeenCalledOnce();
  fake.release();
});

test("a failed native result is observable before the streaming child exits", async () => {
  fake.result = {
    type: "result",
    subtype: "error_during_execution",
    errors: ["context limit"],
  };
  const run = new HeadlessRun(
    {
      sessionId: "00000000-0000-4000-8000-000000000001" as ProviderSessionId,
      cwd: "/tmp/loom-test-headless" as WorktreePath,
      model: "fake",
      settingsPath: "/tmp/loom-test-headless/settings.json",
      readOnly: true,
      resume: false,
      prompt: "event",
    },
    {},
  );
  await vi.waitFor(() => expect(run.state.completedTurns).toBe(1));
  expect(run.state).toMatchObject({
    exited: false,
    lastTurn: { outcome: "failed", error: "context limit" },
  });
  run.close();
  fake.release();
});
