// The hook receiver: a loopback HTTP endpoint that turns Claude Code hooks into receipts.
//
// It answers every request 200 and fast. A refused connection shows the user a hook error after
// every turn, and a slow one adds its timeout to every hook (spike 02, §6), so the handler never
// does work that can block: validate, append, answer, then fan hints out.

import { createServer, type Server } from "node:http";
import type { IsoTime, ProviderSessionId } from "@loom/core";
import type { HookLog, HookReceipt } from "./hooks.js";
import { hookPayloadSchema } from "./hooks.js";

/** Bodies above this are refused unread. 20 KB prompts arrive in full (spike 02, §3). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HookReceiverOptions {
  log: HookLog;
  /** Loopback only. The receiver is never reachable off the machine. */
  host?: string;
  /** 0 (the default) takes an ephemeral port; read `baseUrl` for the one it got. */
  port?: number;
  onReceipt?: (receipt: HookReceipt) => void;
  /** Rejected payloads and handler failures. Never surfaced to the Claude session. */
  onError?: (error: Error) => void;
  now?: () => IsoTime;
}

export interface HookReceiver {
  /** `http://127.0.0.1:<port>`; what the settings generator writes into hook URLs. */
  readonly baseUrl: string;
  close(): Promise<void>;
}

const readBody = (
  req: NodeJS.ReadableStream & { destroy: (error?: Error) => void },
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`hook body over ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export async function startHookReceiver(
  options: HookReceiverOptions,
): Promise<HookReceiver> {
  const host = options.host ?? "127.0.0.1";
  const now = options.now ?? (() => new Date().toISOString() as IsoTime);

  const server: Server = createServer((req, res) => {
    const answer = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    void (async () => {
      try {
        const raw = await readBody(req);
        answer();
        const parsed = hookPayloadSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          options.onError?.(
            new Error(`invalid hook payload: ${parsed.error.message}`),
          );
          return;
        }
        const payload = parsed.data;
        const receipt = await options.log.append({
          sessionId: payload.session_id as ProviderSessionId,
          event: payload.hook_event_name,
          promptId: payload.prompt_id ?? null,
          receivedAt: now(),
          payload,
        });
        options.onReceipt?.(receipt);
      } catch (error) {
        if (!res.writableEnded) answer();
        options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("hook receiver did not bind a TCP port");

  return {
    baseUrl: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
