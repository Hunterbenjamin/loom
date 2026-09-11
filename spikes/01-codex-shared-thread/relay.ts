// Opt-in, transparent protocol recorder for ONLY the spike TUI.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { envelope, redact } from "./client.ts";

if (process.env.LOOM_REAL_PROVIDERS !== "1")
  throw new Error("Set LOOM_REAL_PROVIDERS=1");
const root = process.env.LOOM_SPIKE_ROOT;
if (!root?.endsWith("/loom-spike-01")) throw new Error("Set LOOM_SPIKE_ROOT");
const server = createServer();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/rpc") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (downstream) => {
    const upstream = new WebSocket(`ws+unix://${root}/codex.sock:/rpc`, {
      headers: { Host: "localhost" },
      perMessageDeflate: false,
    });
    const queue: string[] = [];
    const record = (direction: string, bytes: Buffer) => {
      const message = envelope.parse(JSON.parse(bytes.toString()));
      appendFileSync(
        `${root}/logs/tui.jsonl`,
        `${JSON.stringify(redact({ at: new Date().toISOString(), client: "tui", direction, message }))}\n`,
        { mode: 0o600 },
      );
      return JSON.stringify(message);
    };
    downstream.on("message", (bytes: Buffer) => {
      try {
        const message = record("send", bytes);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
        else queue.push(message);
      } catch {
        downstream.close(1002);
      }
    });
    upstream.on("open", () => {
      for (const message of queue) upstream.send(message);
      queue.length = 0;
    });
    upstream.on("message", (bytes: Buffer) => {
      try {
        downstream.send(record("receive", bytes));
      } catch {
        upstream.close(1002);
      }
    });
    downstream.on("close", () => upstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("error", () => upstream.terminate());
    upstream.on("error", () => downstream.terminate());
  });
});
server.listen(`${root}/tui.sock`, () => console.log("Private TUI relay ready"));
