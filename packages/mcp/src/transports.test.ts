import { request } from "node:http";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, test } from "vitest";
import { outputSchemas, resultSchema } from "./schemas.js";
import { setup } from "./test-support.js";
import { serveHttp, serveStdio } from "./transports.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("stdio transports real JSON-RPC bytes through the SDK client with a per-run token", async () => {
  const env = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  const server = await serveStdio(env.options, env.token, { input, output });
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      output.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (;;) {
          const message = buffer.readMessage();
          if (!message) break;
          transport.onmessage?.(message);
        }
      });
    },
    async send(message) {
      input.write(serializeMessage(message));
    },
    async close() {
      input.end();
      output.end();
      transport.onclose?.();
    },
  };
  const client = new Client({ name: "stdio-test", version: "1" });
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  await client.connect(transport);
  expect((await client.listTools()).tools).toHaveLength(7);
  expect(
    (await client.callTool({ name: "get_task_context", arguments: {} }))
      .structuredContent,
  ).toMatchObject({ ok: true, value: { role: "implementer" } });
  expect(env.host.inputs).toEqual([]);
});

async function httpClient(url: URL, token?: string) {
  const client = new Client({ name: "http-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

test("HTTP bearer identity is checked on every request and never carried by a session ID", async () => {
  const env = setup();
  const listener = await serveHttp(env.options);
  cleanup.push(() => listener.close());
  const client = await httpClient(listener.url, env.token);
  expect((await client.listTools()).tools).toHaveLength(7);
  expect(
    (await client.callTool({ name: "get_task_context", arguments: {} }))
      .structuredContent,
  ).toMatchObject({ ok: true });
  env.host.tokens.delete(env.token);
  expect(
    (await client.callTool({ name: "get_task_context", arguments: {} }))
      .structuredContent,
  ).toMatchObject({ ok: false, error: { code: "unknown_run" } });
});
test.each([undefined, "unknown"])(
  "HTTP missing/unknown token returns unknown_run",
  async (token) => {
    const env = setup();
    const listener = await serveHttp(env.options);
    cleanup.push(() => listener.close());
    const client = await httpClient(listener.url, token);
    expect(
      (await client.callTool({ name: "get_task_context", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ ok: false, error: { code: "unknown_run" } });
    expect(env.host.passes).toBe(0);
  },
);
test("HTTP tokens isolate separate runs sharing one endpoint", async () => {
  const first = setup();
  const second = setup("planning", "planner");
  const options = {
    ...first.options,
    resolveToken: (token: string) =>
      token === "second-token"
        ? { runId: second.run.id, active: true }
        : first.host.resolveToken(token),
    host: {
      submit: first.host.submit.bind(first.host),
      context: (id: typeof first.run.id) =>
        id === second.run.id ? second.host.context(id) : first.host.context(id),
    },
  };
  const listener = await serveHttp(options);
  cleanup.push(() => listener.close());
  const [a, b] = await Promise.all([
    httpClient(listener.url, first.token),
    httpClient(listener.url, "second-token"),
  ]);
  const results = await Promise.all(
    [a, b].map((client) =>
      client.callTool({ name: "get_task_context", arguments: {} }),
    ),
  );
  expect(
    results.map((r) => {
      const result = resultSchema(outputSchemas.get_task_context).parse(
        r.structuredContent,
      );
      return result.ok && result.value.view === "full"
        ? result.value.role
        : null;
    }),
  ).toEqual(["implementer", "planner"]);
});
test("HTTP refuses foreign Host/Origin headers and unknown paths", async () => {
  const env = setup();
  const listener = await serveHttp(env.options);
  cleanup.push(() => listener.close());
  async function status(headers: Record<string, string>, path = "/mcp") {
    return new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        new URL(path, listener.url),
        { method: "POST", headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  expect(await status({ Host: "attacker.example" })).toBe(403);
  expect(await status({ Origin: "https://attacker.example" })).toBe(403);
  expect(await status({}, "/other")).toBe(404);
  expect(env.host.inputs).toHaveLength(0);
});
