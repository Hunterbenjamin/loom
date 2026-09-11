import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { Client, envelope, redact } from "./client.ts";

test("protocol envelope rejects malformed results and requests", () => {
  for (const input of [
    { id: 1 },
    { method: 4 },
    { id: 1, error: { message: "bad" } },
    { method: "turn/started", params: [] },
  ])
    assert.equal(envelope.safeParse(input).success, false);
  assert.equal(envelope.safeParse({ id: 1, result: null }).success, true);
  assert.equal(
    envelope.safeParse({ method: "new/event", params: { future: true } })
      .success,
    true,
  );
});

test("logs redact nested credentials and email addresses", () => {
  assert.deepEqual(
    redact({
      access_token: "credential",
      nested: [
        {
          text: `Contact ${["sample", "example.test"].join("@")} ; Bearer abc123; sk-secretvalue`,
        },
      ],
      tokenUsage: { total: 42 },
    }),
    {
      access_token: "<secret>",
      nested: [{ text: "Contact <email> ; Bearer <secret> <secret>" }],
      tokenUsage: { total: 42 },
    },
  );
});

test("fake Unix server exercises framing, approval cleanup, validation and disconnect", async () => {
  const root = join(tmpdir(), "loom-spike-01");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "fake-"));
  const socket = join(directory, "rpc.sock");
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let compression: string | string[] | undefined;
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.url, "/rpc");
    compression = request.headers["sec-websocket-extensions"];
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request),
    );
  });
  wss.on("connection", (ws) => {
    ws.on("message", (bytes) => {
      const m = envelope.parse(JSON.parse(bytes.toString()));
      if (!("method" in m)) return;
      if (m.method === "initialize")
        ws.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === "approval") {
        ws.send(
          JSON.stringify({
            id: 7,
            method: "item/commandExecution/requestApproval",
            params: { command: "echo test" },
          }),
        );
        ws.send(JSON.stringify({ id: m.id, result: {} }));
      }
      if (m.method === "resolve") {
        ws.send(
          JSON.stringify({
            method: "serverRequest/resolved",
            params: { threadId: "owned", requestId: 7 },
          }),
        );
        ws.send(JSON.stringify({ id: m.id, result: {} }));
      }
      if (m.method === "bad-result")
        ws.send(JSON.stringify({ id: m.id, result: { count: "incorrect" } }));
      if (m.method === "disconnect") ws.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const client = await Client.connect(
    socket,
    join(directory, "client.jsonl"),
    "fake",
  );
  try {
    assert.equal(compression, undefined);
    await client.rpc("approval", {}, z.object({}));
    assert.equal(client.requests.size, 1);
    await client.rpc("resolve", {}, z.object({}));
    assert.equal(client.requests.size, 0);
    assert.throws(
      () => client.respond(7, { decision: "accept" }),
      /No pending request/,
    );
    await assert.rejects(
      client.rpc("bad-result", {}, z.object({ count: z.number() })),
    );
    await assert.rejects(
      client.rpc("disconnect", {}, z.object({})),
      /Socket closed/,
    );
    assert.ok(
      readFileSync(join(directory, "client.jsonl"), "utf8").includes(
        '"direction":"close"',
      ),
    );
  } finally {
    client.close();
    wss.close();
    server.close();
  }
});
