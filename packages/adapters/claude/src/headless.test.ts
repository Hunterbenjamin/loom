import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderSessionId, WorktreePath } from "@loom/core";
import { expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  options: null as unknown,
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
        yield { type: "result", subtype: "success" };
        await new Promise<void>((resolve) => {
          fake.release = resolve;
        });
      },
    };
  },
}));

import { HeadlessRun } from "./headless.js";

test("MCP-only disables built-ins and native result is a turn receipt, not child exit", async () => {
  const run = new HeadlessRun(
    {
      sessionId: "00000000-0000-4000-8000-000000000000" as ProviderSessionId,
      cwd: "/tmp/loom-test-operator" as WorktreePath,
      model: "fake",
      settingsPath: "/tmp/loom-test-operator/settings.json",
      readOnly: true,
      mcpOnly: true,
      resume: false,
      prompt: "event",
    },
    { loom: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  );
  await vi.waitFor(() => expect(run.state.completedTurns).toBe(1));
  expect(run.state.exited).toBe(false);
  const options = fake.options as Options;
  expect(options.tools).toEqual([]);
  expect(options.settingSources).toEqual([]);
  expect(options.allowedTools).toEqual(["mcp__loom"]);
  const check = options.canUseTool;
  if (!check) throw new Error("Missing capability gate");
  const context = {
    signal: new AbortController().signal,
    toolUseID: "tool",
    requestId: "permission",
  };
  expect(await check("Bash", { command: "id" }, context)).toMatchObject({
    behavior: "deny",
  });
  expect(
    await check("Read", { file_path: "/tmp/secret" }, context),
  ).toMatchObject({ behavior: "deny" });
  expect(await check("mcp__other__tool", {}, context)).toMatchObject({
    behavior: "deny",
  });
  expect(await check("mcp__loom__file_task", {}, context)).toMatchObject({
    behavior: "allow",
  });
  run.close();
  expect(fake.close).toHaveBeenCalledOnce();
  fake.release();
});
