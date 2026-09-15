import { once } from "node:events";
import { emptySnapshotBody, PROTOCOL_VERSION } from "@loom/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { taskCreateCommand } from "./cli.js";
import { LoomClient } from "./client.js";

let server: WebSocketServer | undefined;
let client: LoomClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  if (server) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

const error = {
  code: "invalid_frame" as const,
  message: "Frame failed the schema",
  details: ["command.title: Too big", "command.repoId: Required"],
};

async function serve(reply: unknown, handshake = false) {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("No address");
  const received = vi.fn();
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      received(frame);
      if (handshake || frame.type === "command") {
        socket.send(JSON.stringify(reply));
        if (handshake) socket.close();
        return;
      }
      if (frame.type !== "hello") return;
      socket.send(
        JSON.stringify({
          type: "welcome",
          protocolVersion: PROTOCOL_VERSION,
          coordinator: {
            instance: "dev",
            version: "0.0.0",
            startedAt: "2026-09-13T00:00:00.000Z",
          },
          clientId: "test-client",
          heartbeatMs: 10000,
          limits: { maxFrameBytes: 8388608, maxSubscriptions: 256 },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "snapshot",
          epoch: "test-epoch",
          seq: 1,
          now: "2026-09-13T00:00:00.000Z",
          requestId: null,
          scope: [],
          body: emptySnapshotBody(),
        }),
      );
    });
  });
  return { url: `ws://127.0.0.1:${address.port}`, received };
}

const options = {
  token: "test-token",
  clientId: "test-client",
  kind: "cli" as const,
};

test.each([
  { type: "error", requestId: null, fatal: true, error },
  { type: "error", requestId: "r1", fatal: false, error },
])(
  "client preserves error-frame details and settles the rejected command: $fatal",
  async (frame) => {
    const { url } = await serve(frame);
    client = await LoomClient.connect({ ...options, url });
    expect(
      await client.command(
        taskCreateCommand(["issue", "create", "repo", "Title"]),
      ),
    ).toEqual({ ok: false, error });
    expect(client.lastError).toBe(error.message);
  },
);

test("client surfaces invalid server-frame details to the pending command", async () => {
  const { url } = await serve({ type: "ping", at: "invalid" });
  client = await LoomClient.connect({ ...options, url });
  const outcome = await client.command(
    taskCreateCommand(["issue", "create", "repo", "Title"]),
  );
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: "invalid_frame", details: [expect.stringMatching(/^at: /)] },
  });
});

test("client rejects an invalid outgoing frame locally with validator details", async () => {
  const { url, received } = await serve(null);
  client = await LoomClient.connect({ ...options, url });
  const outcome = await client.command(
    taskCreateCommand(["issue", "create", "repo", "x".repeat(201)]),
  );
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      code: "invalid_frame",
      details: [expect.stringMatching(/^command\.title: /)],
    },
  });
  expect(received).toHaveBeenCalledTimes(1);
});

test("handshake errors retain details in the callback and thrown error", async () => {
  const { url } = await serve(
    { type: "error", requestId: null, fatal: true, error },
    true,
  );
  const onError = vi.fn();
  await expect(
    LoomClient.connect({ ...options, url, onError }),
  ).rejects.toMatchObject(error);
  expect(onError).toHaveBeenCalledWith(error.message, error);
});
