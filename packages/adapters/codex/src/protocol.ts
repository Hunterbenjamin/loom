import WebSocket from "ws";
import { z } from "zod";
import type { InitializeParams } from "./generated/InitializeParams.js";

const rpcId = z.union([z.string(), z.number().int()]);
const record = z.record(z.string(), z.unknown());
export const envelope = z.union([
  z
    .object({
      method: z.string(),
      params: record.optional(),
      id: rpcId.optional(),
      emittedAtMs: z
        .number()
        .finite()
        .nonnegative()
        .max(8_640_000_000_000_000)
        .optional(),
    })
    .strict(),
  z
    .object({ id: rpcId, result: z.unknown() })
    .strict()
    .refine((v) => "result" in v),
  z
    .object({
      id: rpcId,
      error: z.object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      }),
    })
    .strict(),
]);
export type Incoming = Extract<z.infer<typeof envelope>, { method: string }>;

export function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\bsk-[\w-]+/g, "<secret>")
    .replace(/Bearer\s+\S+/gi, "Bearer <secret>")
    .replace(
      /((?:access_token|refresh_token|id_token|api_key|password)\s*[=:]\s*)\S+/gi,
      "$1<secret>",
    );
}
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(redact(message));
  }
}

/** One initialized WebSocket connection. No retries of possibly executed RPCs. */
export class RpcConnection {
  private sequence = 0;
  private ended = false;
  private pending = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private constructor(
    private readonly socket: WebSocket,
    private readonly timeoutMs: number,
    onMessage: (message: Incoming) => void,
    private readonly onDisconnect: () => void,
  ) {
    socket.on("message", (raw) => {
      try {
        const message = envelope.parse(JSON.parse(raw.toString()));
        if ("method" in message) onMessage(message);
        else {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if ("error" in message)
            pending.reject(
              new RpcError(message.error.code, message.error.message),
            );
          else pending.resolve(message.result);
        }
      } catch {
        this.fail(new Error("Invalid Codex protocol message"));
        socket.terminate();
      }
    });
    socket.on("close", () => this.fail(new Error("Codex connection closed")));
    socket.on("error", () =>
      this.fail(new Error("Codex connection unavailable")),
    );
  }
  get connected() {
    return !this.ended && this.socket.readyState === WebSocket.OPEN;
  }
  static async connect(options: {
    socketPath: string;
    timeoutMs: number;
    onMessage: (message: Incoming) => void;
    onDisconnect: () => void;
  }): Promise<{ connection: RpcConnection; codexHome: string }> {
    const socket = new WebSocket(`ws+unix://${options.socketPath}:/rpc`, {
      headers: { Host: "localhost" },
      perMessageDeflate: false,
      handshakeTimeout: options.timeoutMs,
    });
    const connection = new RpcConnection(
      socket,
      options.timeoutMs,
      options.onMessage,
      options.onDisconnect,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", () =>
          reject(new Error("Codex connection unavailable")),
        );
        socket.once("close", () =>
          reject(new Error("Codex connection closed during handshake")),
        );
      });
      const params: InitializeParams = {
        clientInfo: { name: "loom", title: "Loom", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      const initialized = await connection.rpc(
        "initialize",
        params,
        z.object({
          userAgent: z.string(),
          codexHome: z.string().min(1),
          platformFamily: z.string(),
          platformOs: z.string(),
        }),
      );
      connection.send({ method: "initialized", params: {} });
      return { connection, codexHome: initialized.codexHome };
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onDisconnect();
  }
  send(message: unknown) {
    if (!this.connected) throw new Error("Codex connection unavailable");
    this.socket.send(JSON.stringify(message));
  }
  async rpc<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const id = `loom:${++this.sequence}`;
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Codex RPC timed out: ${method}; delivery is unknown`),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw new Error(`Invalid Codex response: ${method}`);
    return parsed.data;
  }
  close() {
    this.fail(new Error("Codex connection closed"));
    this.socket.terminate();
  }
}
