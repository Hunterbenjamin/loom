import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAdapter } from "@loom/core";
import { expect, test, vi } from "vitest";
import { textHash } from "./hooks.js";
import { promptReceipt } from "./receipts.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionMessages: vi.fn(),
}));
const request: Parameters<ClaudeAdapter["promptReceipt"]>[0] = {
  sessionId: "test-session" as never,
  cwd: "/test/operator" as never,
  textHash: textHash("Message from Main: hello\n    world"),
  after: "2026-09-13T07:59:00.000Z" as never,
  before: "2026-09-13T08:00:00.000Z" as never,
};
const message = {
  type: "user" as const,
  uuid: "prompt-id",
  session_id: request.sessionId,
  timestamp: request.after,
  parent_tool_use_id: null,
  parent_agent_id: null,
  message: { role: "user", content: "Message from Main: hello\r\n\tworld" },
};
test("reads the named provider transcript and matches normalized input at the attempt boundary", async () => {
  vi.mocked(getSessionMessages).mockResolvedValue([message]);
  expect(await promptReceipt(request)).toEqual({
    promptId: "prompt-id",
    textHash: request.textHash,
    at: request.after,
  });
  expect(getSessionMessages).toHaveBeenLastCalledWith(request.sessionId, {
    dir: request.cwd,
  });
});
for (const change of [
  { session_id: "another-session" },
  { timestamp: "2026-09-13T07:58:59.999Z" },
  { timestamp: "2026-09-13T08:00:00.001Z" },
  { timestamp: undefined },
  { type: "assistant" as const },
  { is_meta: true },
  { parent_tool_use_id: "tool" },
  { message: { role: "user", content: "different text" } },
  {
    message: {
      role: "user",
      content: [{ type: "tool_result", content: message.message.content }],
    },
  },
])
  test(`rejects unrelated or unqualified transcript evidence: ${JSON.stringify(change)}`, async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      { ...message, ...change },
    ]);
    expect(await promptReceipt(request)).toBeNull();
  });
test("read errors do not become negative delivery evidence", async () => {
  vi.mocked(getSessionMessages).mockRejectedValue(
    new Error("read unavailable"),
  );
  await expect(promptReceipt(request)).rejects.toThrow("read unavailable");
});
