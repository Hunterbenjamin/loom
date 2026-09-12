import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";
import { envelope, event, eventTypes } from "./schemas.js";

/** Never includes raw payloads or server messages (which may contain user text). */
export class HerdrError extends Error {
  constructor(public readonly code: string) {
    super(`Herdr: ${code}`);
  }
}

export interface SocketOptions {
  socketPath: string;
  requestTimeoutMs: number;
  reconnectMs: number;
  onError?: (error: HerdrError) => void;
}

// UTF-8 decoding handles split multibyte characters; cap unfinished frames as well as whole ones.
function lines(
  socket: Socket,
  consume: (value: unknown) => void,
  fail: () => void,
) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      if (end > 4 * 1024 * 1024) return fail();
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        consume(JSON.parse(line));
      } catch {
        return fail();
      }
      if (socket.destroyed) return;
    }
    if (buffer.length > 4 * 1024 * 1024) fail();
  });
}

export class HerdrSocket {
  constructor(private readonly options: SocketOptions) {}

  // One connection per request. No replay after a disconnect: mutation outcome is unknown.
  request<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = createConnection(this.options.socketPath);
      let settled = false;
      const finish = (error?: HerdrError, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => finish(new HerdrError("transport_timeout")),
        this.options.requestTimeoutMs,
      );
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ id, method, params })}\n`),
      );
      socket.on("error", () => finish(new HerdrError("disconnected")));
      socket.on("close", () => finish(new HerdrError("disconnected")));
      lines(
        socket,
        (value) => {
          const response = envelope.parse(value);
          if (response.id !== id) throw new HerdrError("invalid_response");
          if ("error" in response) finish(new HerdrError(response.error.code));
          else finish(undefined, schema.parse(response.result));
        },
        () => finish(new HerdrError("invalid_response")),
      );
    });
  }

  subscribe(onHint: () => void): () => void {
    let stopped = false;
    let socket: Socket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const id = randomUUID();
      let acknowledged = false;
      let reported = false;
      socket = createConnection(this.options.socketPath);
      const fail = (code: string) => {
        if (reported || stopped) return;
        reported = true;
        this.options.onError?.(new HerdrError(code));
        socket.destroy();
      };
      deadline = setTimeout(
        () => fail("subscription_timeout"),
        this.options.requestTimeoutMs,
      );
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({
            id,
            method: "events.subscribe",
            params: { subscriptions: eventTypes.map((type) => ({ type })) },
          })}\n`,
        ),
      );
      lines(
        socket,
        (value) => {
          if (!acknowledged) {
            const response = envelope.parse(value);
            if (response.id !== id) throw new HerdrError("invalid_response");
            if ("error" in response) return fail(response.error.code);
            z.object({ type: z.literal("subscription_started") }).parse(
              response.result,
            );
            acknowledged = true;
            clearTimeout(deadline);
            onHint(); // Re-read after initial connection and every reconnect to close the gap.
          } else {
            event.parse(value);
            onHint();
          }
        },
        () => fail("invalid_event"),
      );
      socket.on("error", () => fail("disconnected"));
      socket.on("close", () => {
        clearTimeout(deadline);
        if (stopped) return;
        fail("disconnected");
        onHint(); // Observations are now unknown until fresh reads succeed.
        retry = setTimeout(connect, this.options.reconnectMs);
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(deadline);
      socket.destroy();
    };
  }
}
