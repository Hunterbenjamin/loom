// Test-only app-server. No provider CLI, credentials, or agent process is used.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { envelope } from "./protocol.js";

export async function fakeServer() {
  const directory = await mkdtemp("/tmp/loom-codex-test-");
  const home = join(directory, "codex-home");
  await mkdir(home);
  const http = createServer();
  const ws = new WebSocketServer({ server: http, perMessageDeflate: false });
  const messages: { connection: number; message: unknown }[] = [];
  const headers: { host?: string; extension?: string; url?: string }[] = [];
  let connections = 0;
  let handler: (
    method: string,
    params: Record<string, unknown>,
    socket: WebSocket,
  ) => unknown = () => ({});
  ws.on("connection", (socket, request) => {
    const connection = ++connections;
    headers.push({
      host: request.headers.host,
      extension: request.headers["sec-websocket-extensions"],
      url: request.url,
    });
    socket.on("message", (raw) => {
      const message = envelope.parse(JSON.parse(raw.toString()));
      messages.push({ connection, message });
      if (!("method" in message) || message.id === undefined) return;
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              userAgent: "codex/0.154.0",
              codexHome: home,
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );
        return;
      }
      const result = handler(message.method, message.params ?? {}, socket);
      if (result === undefined) return;
      socket.send(JSON.stringify({ id: message.id, ...result }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(join(directory, "app-server.sock"), resolve);
  });
  return {
    directory,
    home,
    messages,
    headers,
    get connections() {
      return connections;
    },
    handle(fn: typeof handler) {
      handler = fn;
    },
    broadcast(message: unknown) {
      for (const socket of ws.clients) socket.send(JSON.stringify(message));
    },
    disconnect() {
      for (const socket of ws.clients) socket.terminate();
    },
    async close() {
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
