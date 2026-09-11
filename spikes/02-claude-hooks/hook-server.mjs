// Spike 02: append every Claude Code hook payload to a JSONL file with a receive timestamp.
// Usage: node hook-server.mjs [port] [out.jsonl]
// Env: HANG=1 accepts requests but never answers (simulates a stuck coordinator).
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 47802);
const out = process.argv[3] ?? "hooks.jsonl";
const hang = process.env.HANG === "1";

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const recv_ms = Date.now();
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { unparsed: raw };
    }
    appendFileSync(out, `${JSON.stringify({ recv_ms, path: req.url, hang, body })}\n`);
    if (hang) return; // leave the socket open
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`hook-server on 127.0.0.1:${port} -> ${out}${hang ? " (HANG)" : ""}`);
});
