import { expect, test, vi } from "vitest";

const fake = vi.hoisted(() => ({
  messages: [] as unknown[],
  options: null as Record<string, unknown> | null,
  close: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    fake.options = options;
    return {
      close: fake.close,
      async *[Symbol.asyncIterator]() {
        for (const message of fake.messages) yield message;
      },
    };
  },
}));

import { createBriefResearch } from "./research.js";

const request = () => ({
  sessionId: "00000000-0000-4000-8000-000000000001",
  cwd: "/tmp/loom-test-brief",
  model: "fake",
  prompt: "Research",
  controller: new AbortController(),
});
const content = {
  headline: "Quiet day",
  summary: "No significant update.",
  items: [],
  workflowExperiment: "Evaluate review time.",
  opportunity: null,
  coverage: "Checked primary sources.",
};
const web = [
  {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "search-1", name: "WebSearch" }],
    },
  },
  {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "search-1",
          content: "Sources",
          is_error: false,
        },
      ],
    },
  },
];
test("uses only web tools, isolated settings, persisted identity and bounded structured results", async () => {
  fake.messages = [
    ...web,
    { type: "result", subtype: "success", structured_output: content },
  ];
  expect(await createBriefResearch("claude")(request())).toEqual(content);
  expect(fake.options).toMatchObject({
    tools: ["WebSearch", "WebFetch"],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    permissionMode: "dontAsk",
    sessionId: request().sessionId,
    maxBudgetUsd: 3,
    maxTurns: 30,
    outputFormat: {
      schema: { $schema: "http://json-schema.org/draft-07/schema#" },
    },
  });
  expect(fake.close).toHaveBeenCalled();
});
test("rejects ungrounded, malformed and failed provider results", async () => {
  fake.messages = [
    { type: "result", subtype: "success", structured_output: content },
  ];
  await expect(createBriefResearch("claude")(request())).rejects.toThrow(
    "live web lookup",
  );
  fake.messages = [
    ...web,
    {
      type: "result",
      subtype: "success",
      structured_output: { ...content, items: [{ title: "Missing sources" }] },
    },
  ];
  await expect(createBriefResearch("claude")(request())).rejects.toThrow();
  fake.messages = [...web, { type: "result", subtype: "error_max_budget_usd" }];
  await expect(createBriefResearch("claude")(request())).rejects.toThrow(
    "error_max_budget_usd",
  );
});
