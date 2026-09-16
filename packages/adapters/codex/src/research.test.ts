import { afterEach, expect, test } from "vitest";
import { fakeServer } from "./fake-server.js";
import { RpcConnection } from "./protocol.js";
import { runCodexResearch } from "./research.js";

const document = {
  title: "A short answer",
  body: "First paragraph.\n\nSecond paragraph.",
  sources: [{ title: "Source", url: "https://example.org" }],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup({
  web = true,
  prose = false,
  tokens = 0,
  inProgress = false,
  webCount = 1,
  webStatus = "completed",
} = {}) {
  const fake = await fakeServer();
  cleanups.push(() => fake.close());
  const notifications = new Set<(method: string, params: unknown) => void>();
  const { connection } = await RpcConnection.connect({
    socketPath: `${fake.directory}/app-server.sock`,
    timeoutMs: 2000,
    onMessage: (message) => {
      for (const listener of notifications)
        listener(message.method, message.params);
    },
    onDisconnect: () => {},
  });
  cleanups.push(async () => connection.close());
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let persisted = false;
  fake.handle((method, params, socket) => {
    calls.push({ method, params });
    if (method === "thread/start")
      return {
        result: {
          thread: {
            id: "research-thread",
            cwd: fake.directory,
            updatedAt: 1,
            status: { type: "idle" },
          },
        },
      };
    if (method === "turn/start") {
      expect(persisted).toBe(true);
      for (let index = 0; web && index < webCount; index += 1)
        socket.send(
          JSON.stringify({
            method: "rawResponseItem/completed",
            params: {
              threadId: "research-thread",
              turnId: "turn",
              item: {
                type: "web_search_call",
                id: `web-${index}`,
                status: webStatus,
              },
            },
          }),
        );
      if (tokens) {
        const counts = {
          totalTokens: tokens,
          inputTokens: tokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 0,
        };
        socket.send(
          JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "research-thread",
              turnId: "turn",
              tokenUsage: {
                total: counts,
                last: counts,
                modelContextWindow: null,
              },
            },
          }),
        );
      }
      return { result: { turn: { id: "turn", status: "inProgress" } } };
    }
    if (method === "thread/read")
      return {
        result: {
          thread: {
            turns: [
              {
                id: "turn",
                status: inProgress ? "inProgress" : "completed",
                error: null,
                items: [
                  {
                    type: "agentMessage",
                    text: prose ? "This is prose" : JSON.stringify(document),
                  },
                ],
              },
            ],
          },
        },
      };
    if (method === "turn/interrupt") return { result: {} };
    throw new Error(`Unexpected method ${method}`);
  });
  const controller = new AbortController();
  const request = {
    cwd: fake.directory,
    sessionId: "before-start",
    model: "gpt-5.6-sol",
    prompt: "Only web research",
    reasoningEffort: "medium" as const,
    limits: { turns: 10, tokens: 30000 },
    controller,
    onSession: (id: string) => {
      expect(id).toBe("research-thread");
      persisted = true;
    },
  };
  const run = () =>
    runCodexResearch(connection, request, (listener) => {
      notifications.add(listener);
      return () => {
        notifications.delete(listener);
      };
    });
  return { run, calls, request };
}
test("fake app-server receives isolated read-only thread and output schema, and the full document is read", async () => {
  const { run, calls } = await setup();
  expect(await run()).toEqual(document);
  expect(
    calls.find((call) => call.method === "thread/start")?.params,
  ).toMatchObject({
    sandbox: "read-only",
    environments: [],
    runtimeWorkspaceRoots: [],
    config: {
      web_search: "live",
      mcp_servers: {},
      features: { shell_tool: false, multi_agent: false },
    },
    experimentalRawEvents: true,
  });
  expect(
    calls.find((call) => call.method === "turn/start")?.params,
  ).toMatchObject({
    outputSchema: { type: "object", required: ["title", "body", "sources"] },
  });
});
test("the output schema carries no string format OpenAI rejects", async () => {
  const { run, calls } = await setup();
  await run();
  const schema = calls.find((call) => call.method === "turn/start")?.params as {
    outputSchema: unknown;
  };
  const formats: unknown[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    const node = value as Record<string, unknown>;
    if ("format" in node) formats.push(node.format);
    Object.values(node).forEach(walk);
  };
  walk(schema.outputSchema);
  // The document's source URLs are z.url(), which emits format: "uri"; OpenAI refuses that
  // schema with invalid_json_schema, so the request never reaches the model.
  expect(formats).not.toContain("uri");
});
test("rejects prose and documents without observed live web success", async () => {
  await expect((await setup({ web: false })).run()).rejects.toThrow(
    "live web lookup",
  );
  await expect((await setup({ prose: true })).run()).rejects.toThrow(
    "This is prose",
  );
});
test("token ceiling interrupts the owned turn", async () => {
  const { run, calls } = await setup({ tokens: 30001, inProgress: true });
  await expect(run()).rejects.toThrow("token ceiling");
  expect(calls.at(-1)).toMatchObject({
    method: "turn/interrupt",
    params: { threadId: "research-thread", turnId: "turn" },
  });
});
test("abort interrupts the owned turn", async () => {
  const { run, calls, request } = await setup({ inProgress: true });
  const result = run();
  const timer = setTimeout(() => request.controller.abort(), 50);
  await expect(result).rejects.toThrow();
  clearTimeout(timer);
  expect(calls.at(-1)?.method).toBe("turn/interrupt");
});

test("failed web calls do not count as live evidence, and depth bounds the lookup loop", async () => {
  await expect((await setup({ webStatus: "failed" })).run()).rejects.toThrow(
    "live web lookup",
  );
  const { run, calls } = await setup({ webCount: 11, inProgress: true });
  await expect(run()).rejects.toThrow("lookup limit");
  expect(calls.at(-1)?.method).toBe("turn/interrupt");
});
