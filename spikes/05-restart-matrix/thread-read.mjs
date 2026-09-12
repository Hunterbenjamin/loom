// Read one thread from a Codex app-server over its unix socket.
//   node thread-read.mjs <socket-path> <thread-id> [--turns]
// Transport options (ws+unix, /rpc, no permessage-deflate) come from spike 01.
import WebSocket from "ws";

const [socket, threadId, ...flags] = process.argv.slice(2);
if (!socket || !threadId) {
  console.error("usage: thread-read.mjs <socket> <thread-id> [--turns]");
  process.exit(2);
}
const includeTurns = flags.includes("--turns");

const ws = new WebSocket(`ws+unix://${socket}:/rpc`, {
  headers: { Host: "localhost" },
  perMessageDeflate: false,
});

let nextId = 1;
const pending = new Map();
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

ws.on("open", async () => {
  try {
    await call("initialize", {
      clientInfo: { name: "loom-spike-05", title: "loom-spike-05", version: "0.0.0" },
      experimentalApi: true,
    });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    const thread = await call("thread/read", { threadId, includeTurns });
    console.log(JSON.stringify(thread, null, 2));
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
ws.on("error", (err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
