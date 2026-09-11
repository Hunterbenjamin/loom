import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { z } from "zod";
import type { InitializeParams } from "./generated/InitializeParams";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams";

const id = z.union([z.string(), z.number()]);
const object = z.record(z.string(), z.unknown());
export const envelope = z.union([
  z.object({
    method: z.string(),
    params: object.optional(),
    id: id.optional(),
  }),
  z.object({ id, result: z.unknown() }).refine((v) => "result" in v),
  z.object({
    id,
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);
export type Message = z.infer<typeof envelope>;
export function redact(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
      .replace(/\bsk-[\w-]+/g, "<secret>")
      .replace(/Bearer\s+\S+/gi, "Bearer <secret>");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(access_token|refresh_token|id_token|api_key|authorization|password)$/i.test(
          k,
        )
          ? "<secret>"
          : redact(v),
      ]),
    );
  return value;
}
const status = z.discriminatedUnion("type", [
  z.object({ type: z.literal("active"), activeFlags: z.array(z.string()) }),
  z.object({ type: z.enum(["idle", "notLoaded", "systemError"]) }),
]);
export const threadResult = z
  .object({
    thread: z
      .object({
        id: z.string(),
        cwd: z.string(),
        status,
        turns: z.array(
          z
            .object({
              id: z.string(),
              status: z.enum([
                "inProgress",
                "completed",
                "interrupted",
                "failed",
              ]),
              items: z.array(object),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const turnResult = z.object({
  turn: z.object({ id: z.string(), status: z.string() }).passthrough(),
});
export class Client {
  readonly messages: Message[] = [];
  readonly requests = new Map<
    string | number,
    { method: string; params?: Record<string, unknown> }
  >();
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private sequence = 0;
  private constructor(
    readonly ws: WebSocket,
    readonly logPath: string,
    readonly name: string,
  ) {
    mkdirSync(dirname(logPath), { recursive: true });
    ws.on("message", (raw) => {
      try {
        const message = envelope.parse(JSON.parse(raw.toString()));
        this.log("receive", message);
        this.messages.push(message);
        if ("method" in message) {
          if (message.id !== undefined) this.requests.set(message.id, message);
          if (message.method === "serverRequest/resolved") {
            const p = z.object({ requestId: id }).parse(message.params);
            this.requests.delete(p.requestId);
          }
        } else {
          const p = this.pending.get(String(message.id));
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(String(message.id));
            if ("error" in message)
              p.reject(new Error(JSON.stringify(message.error)));
            else p.resolve(message.result);
          }
        }
      } catch (error) {
        this.log("invalid", { error: String(error) });
        this.fail(new Error("Invalid protocol message"));
        ws.close(1002, "Invalid protocol message");
      }
    });
    ws.on("close", (code) => {
      this.log("close", { code });
      this.fail(new Error(`Socket closed: ${code}`));
    });
    ws.on("error", (error) => {
      this.log("error", { error: String(error) });
      this.fail(error);
    });
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  log(direction: string, message: unknown) {
    appendFileSync(
      this.logPath,
      `${JSON.stringify(redact({ at: new Date().toISOString(), client: this.name, direction, message }))}\n`,
      { mode: 0o600 },
    );
  }
  static async connect(socket: string, log: string, name: string) {
    const ws = new WebSocket(`ws+unix://${socket}:/rpc`, {
      headers: { Host: "localhost" },
      perMessageDeflate: false,
    });
    const client = new Client(ws, log, name);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const params: InitializeParams = {
      clientInfo: {
        name: `loom_spike_01_${name}`,
        title: "Loom spike 01",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await client.rpc("initialize", params, object);
    client.send({ method: "initialized", params: {} });
    return client;
  }
  send(message: unknown) {
    if (this.ws.readyState !== WebSocket.OPEN)
      throw new Error("Socket not open");
    this.log("send", message);
    this.ws.send(JSON.stringify(message));
  }
  async rpc<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    timeoutMs = 30000,
  ): Promise<T> {
    const requestId = `${this.name}:${++this.sequence}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({ id: requestId, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
    return schema.parse(await response);
  }
  respond(requestId: string | number, result: unknown) {
    if (!this.requests.has(requestId))
      throw new Error(`No pending request ${requestId}`);
    this.send({ id: requestId, result });
    this.requests.delete(requestId);
  }
  async waitFor(
    method: string,
    since = 0,
    timeoutMs = 45000,
    matches: (m: Message) => boolean = () => true,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages
        .slice(since)
        .find((m) => "method" in m && m.method === method && matches(m));
      if (found && "method" in found) return found;
      if (this.ws.readyState !== WebSocket.OPEN)
        throw new Error("Disconnected while waiting");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timeout waiting for ${method}`);
  }
  close() {
    this.ws.close();
  }
}

const command = z.object({
  cmd: z.enum([
    "models",
    "start",
    "resume",
    "turn",
    "steer",
    "interrupt",
    "approve",
    "decline",
    "answer",
    "read",
    "loaded",
    "list",
    "limits",
    "events",
    "pending",
    "quit",
  ]),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  text: z.string().optional(),
  requestId: id.optional(),
  options: object.optional(),
  answers: z
    .record(z.string(), z.object({ answers: z.array(z.string()) }))
    .optional(),
});
async function main() {
  if (process.env.LOOM_REAL_PROVIDERS !== "1")
    throw new Error("Set LOOM_REAL_PROVIDERS=1 for the opt-in live client");
  const root = process.env.LOOM_SPIKE_ROOT;
  if (!root || !resolve(root).endsWith("/loom-spike-01"))
    throw new Error(
      "Set LOOM_SPIKE_ROOT to the isolated .../loom-spike-01 directory",
    );
  const name = process.argv[2] ?? "client";
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error("Invalid client name");
  const client = await Client.connect(
    `${root}/codex.sock`,
    `${root}/logs/${name}.jsonl`,
    name,
  );
  const registryPath = `${root}/owned-threads.json`;
  const owned = () => {
    try {
      return z
        .array(z.string())
        .parse(JSON.parse(readFileSync(registryPath, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  };
  let threadId: string | undefined;
  let turnId: string | undefined;
  let eventCursor = 0;
  const output = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(redact(value))}\n`);
  output({ ready: name });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const c = command.parse(JSON.parse(line));
      threadId = c.threadId ?? threadId;
      turnId = c.turnId ?? turnId;
      const requireThread = () => {
        if (!threadId || !owned().includes(threadId))
          throw new Error("Thread not in this spike's owned registry");
        return threadId;
      };
      const input = () => [
        {
          type: "text" as const,
          text: z.string().min(1).parse(c.text),
          text_elements: [],
        },
      ];
      let result: unknown;
      switch (c.cmd) {
        case "models":
          result = await client.rpc(
            "model/list",
            { includeHidden: true },
            z.object({
              data: z.array(object),
              nextCursor: z.string().nullable(),
            }),
          );
          break;
        case "start": {
          const params: ThreadStartParams = {
            ...c.options,
            cwd: `${root}/repo`,
            model: process.env.LOOM_SPIKE_MODEL ?? "gpt-5.6-luna",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: "workspace-write",
            config: {
              ...z.record(z.string(), z.json()).parse(c.options?.config ?? {}),
              model_reasoning_effort: "low",
            },
          };
          result = await client.rpc("thread/start", params, threadResult);
          threadId = threadResult.parse(result).thread.id;
          writeFileSync(
            registryPath,
            JSON.stringify([...new Set([...owned(), threadId])]),
            { mode: 0o600 },
          );
          break;
        }
        case "resume": {
          const p: ThreadResumeParams = {
            ...c.options,
            threadId: requireThread(),
          };
          result = await client.rpc("thread/resume", p, threadResult);
          break;
        }
        case "turn": {
          const p: TurnStartParams = {
            ...c.options,
            threadId: requireThread(),
            input: input(),
          };
          const r = await client.rpc("turn/start", p, turnResult);
          turnId = r.turn.id;
          result = r;
          break;
        }
        case "steer": {
          const p: TurnSteerParams = {
            threadId: requireThread(),
            expectedTurnId: z.string().parse(turnId),
            input: input(),
          };
          result = await client.rpc("turn/steer", p, object);
          break;
        }
        case "interrupt":
          result = await client.rpc(
            "turn/interrupt",
            { threadId: requireThread(), turnId: z.string().parse(turnId) },
            object,
          );
          break;
        case "approve":
        case "decline": {
          const requestId = id.parse(c.requestId);
          const request = client.requests.get(requestId);
          if (request?.method !== "item/commandExecution/requestApproval")
            throw new Error("Not a command approval request");
          const r: CommandExecutionRequestApprovalResponse = {
            decision: c.cmd === "approve" ? "accept" : "decline",
          };
          client.respond(requestId, r);
          result = { answered: requestId };
          break;
        }
        case "answer": {
          const requestId = id.parse(c.requestId);
          if (
            client.requests.get(requestId)?.method !==
            "item/tool/requestUserInput"
          )
            throw new Error("Not user input");
          client.respond(requestId, { answers: c.answers ?? {} });
          result = { answered: requestId };
          break;
        }
        case "read":
          result = await client.rpc(
            "thread/read",
            { threadId: requireThread(), includeTurns: true },
            threadResult,
          );
          break;
        case "loaded":
          result = await client.rpc(
            "thread/loaded/list",
            {},
            z.object({
              data: z.array(z.string()),
              nextCursor: z.string().nullable(),
            }),
          );
          break;
        case "list":
          result = await client.rpc(
            "thread/list",
            {
              cwd: [`${root}/repo`, realpathSync(`${root}/repo`)],
              useStateDbOnly: true,
            },
            z.object({
              data: z.array(object),
              nextCursor: z.string().nullable(),
            }),
          );
          break;
        case "limits":
          result = await client.rpc("account/rateLimits/read", {}, object);
          break;
        case "events":
          result = client.messages
            .slice(eventCursor)
            .filter((m) => "method" in m);
          eventCursor = client.messages.length;
          break;
        case "pending":
          result = [...client.requests].map(([id, request]) => ({
            id,
            ...request,
          }));
          break;
        case "quit":
          lines.close();
          process.stdin.pause();
          client.close();
          return;
      }
      output({ cmd: c.cmd, result });
    } catch (error) {
      output({ error: String(error) });
    }
  }
  client.close();
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${String(redact(String(error)))}\n`);
    process.exitCode = 1;
  });
}
