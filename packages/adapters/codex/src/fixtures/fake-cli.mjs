#!/usr/bin/env node
// Fake provider process, used only by offline lifecycle tests.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.154.0\n");
} else {
  const socketPath = process.argv[4].replace(/^unix:\/\//, "");
  writeFileSync(
    join(process.cwd(), "fake-process.json"),
    JSON.stringify({
      pid: process.pid,
      home: process.env.CODEX_HOME,
      inheritedHerdr: Object.keys(process.env).some((key) =>
        key.startsWith("HERDR_"),
      ),
      inheritedClaude: Object.keys(process.env).some((key) =>
        key.startsWith("CLAUDE_CODE_"),
      ),
    }),
  );
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === "initialize")
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              userAgent: "codex/0.154.0",
              codexHome: process.env.CODEX_HOME,
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );
    });
  });
  server.listen(socketPath);
}
