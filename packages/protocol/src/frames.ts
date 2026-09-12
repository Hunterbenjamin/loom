// Transport: one WebSocket per window, on the coordinator's bind address (loopback by default,
// configurable so a phone or an always-on host can follow later without a rewrite).
//
// Framing. One JSON object per WebSocket text message, UTF-8, no framing of our own and no
// batching across messages: a message that doesn't parse as the frame schema below is a protocol
// error, never a partial read. Binary messages are rejected. Frames larger than
// `MAX_FRAME_BYTES` are rejected before parsing; a diff that big is fetched over several
// requests instead.
//
// Handshake.
//   1. The client opens the socket. It sends nothing else first.
//   2. The client sends `hello` with the protocol version, its token and what it wants to watch.
//      The token goes in this frame, or in an `Authorization: Bearer` header. It must never go in
//      the URL: query strings end up in logs and in `ps`.
//   3. The coordinator replies `welcome`, then a `snapshot` for the requested scope, then patches.
//      On failure it sends one `error` frame and closes with the matching code below.
//   4. Any frame other than `hello` before the handshake completes is `not_authenticated` and
//      closes the socket. A second `hello` is `already_authenticated`.
//   5. `ping` and `pong` keep the connection honest; a client that misses `heartbeatMs * 3` is
//      dropped. The coordinator keeps no per-client state worth recovering, so a drop costs a
//      reconnect and a fresh snapshot.
//
// Sequence numbers are per connection and contiguous, so a gap always means loss: subscriptions
// filter the stream, and a coordinator-wide counter would leave legitimate holes a client could
// not tell from dropped frames.

import { z } from "zod";
import { ack, commandRequest, protocolError } from "./commands.js";
import { clientId, isoTime, requestId, seq } from "./ids.js";
import { patchBody } from "./patch.js";
import { snapshotBody, snapshotMeta } from "./snapshot.js";
import { subscription } from "./subscriptions.js";

export const PROTOCOL_VERSION = 1;

/** 8 MiB. A patch never approaches it; `fetch_diff` is the only frame that can grow. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Close codes in the private range. The `error` frame carries the reason in words. */
export const CLOSE = {
  unauthorized: 4001,
  unsupportedProtocolVersion: 4002,
  badFrame: 4003,
  handshakeTimeout: 4004,
  tooManyClients: 4005,
  /** The coordinator is shutting down or restarting; reconnect with backoff. */
  goingAway: 4006,
  heartbeatTimeout: 4007,
} as const;

export const clientKind = z.enum(["tracker", "workbench", "cli", "web"]);

export const hello = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  /** The coordinator's token. Compared in constant time; never logged. */
  token: z.string().min(1).max(512),
  client: z.strictObject({
    /** Stable per window, so a reconnect is recognizable in the coordinator's log. */
    id: clientId,
    kind: clientKind,
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
  }),
  subscriptions: z.array(subscription).max(256),
});

export const welcome = z.strictObject({
  type: z.literal("welcome"),
  protocolVersion: z.number().int().positive(),
  coordinator: z.strictObject({
    /** `LOOM_INSTANCE`: dev and prod never share a data directory, or a client. */
    instance: z.string().min(1),
    version: z.string().min(1),
    startedAt: isoTime,
  }),
  clientId,
  heartbeatMs: z.number().int().positive(),
  limits: z.strictObject({
    maxFrameBytes: z.number().int().positive(),
    maxSubscriptions: z.number().int().positive(),
  }),
});

export const snapshotFrame = z.strictObject({
  type: z.literal("snapshot"),
  ...snapshotMeta.shape,
  /** Set when this snapshot answers a `resync` or a `subscribe`. */
  requestId: requestId.nullable(),
  /** What this snapshot covers. A client compares it with what it asked for. */
  scope: z.array(subscription),
  body: snapshotBody,
});

export const patchFrame = z.strictObject({
  type: z.literal("patch"),
  ...patchBody.shape,
});

export const subscribeFrame = z.strictObject({
  type: z.literal("subscribe"),
  requestId,
  add: z.array(subscription).max(256),
  remove: z.array(subscription).max(256),
  /**
   * True when the client wants a snapshot for the new scope rather than patches that fill it in.
   * The coordinator may send one anyway; adding a task subscription usually means it must.
   */
  wantSnapshot: z.boolean(),
});

export const resyncFrame = z.strictObject({
  type: z.literal("resync"),
  requestId,
  reason: z.enum(["sequence_gap", "reconnect", "client_request"]),
  /** The last sequence the client applied, so the log says how much was lost. */
  haveSeq: seq.nullable(),
});

export const errorFrame = z.strictObject({
  type: z.literal("error"),
  /** The request that failed, or null for a connection-level failure. */
  requestId: requestId.nullable(),
  error: protocolError,
  /** True when the coordinator is closing the socket after this frame. */
  fatal: z.boolean(),
});

export const ping = z.strictObject({ type: z.literal("ping"), at: isoTime });
export const pong = z.strictObject({ type: z.literal("pong"), at: isoTime });

export const clientFrame = z.discriminatedUnion("type", [
  hello,
  subscribeFrame,
  resyncFrame,
  commandRequest,
  ping,
  pong,
]);

export const serverFrame = z.discriminatedUnion("type", [
  welcome,
  snapshotFrame,
  patchFrame,
  ack,
  errorFrame,
  ping,
  pong,
]);

export type ClientFrame = z.output<typeof clientFrame>;
export type ServerFrame = z.output<typeof serverFrame>;
export type SnapshotFrame = z.output<typeof snapshotFrame>;
export type PatchFrame = z.output<typeof patchFrame>;
export type Hello = z.output<typeof hello>;
export type Welcome = z.output<typeof welcome>;

export type Decoded<T> =
  | { ok: true; frame: T }
  | { ok: false; error: z.output<typeof protocolError> };

const decode = <T>(schema: z.ZodType<T>, raw: string): Decoded<T> => {
  if (new TextEncoder().encode(raw).length > MAX_FRAME_BYTES)
    return {
      ok: false,
      error: {
        code: "invalid_frame",
        message: "Frame is larger than the limit",
        details: [`maxFrameBytes=${MAX_FRAME_BYTES}`],
      },
    };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "invalid_frame",
        message: "Frame is not JSON",
        details: [cause instanceof Error ? cause.message : String(cause)],
      },
    };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, frame: parsed.data };
  return {
    ok: false,
    error: {
      code: "invalid_frame",
      message: "Frame failed the schema",
      details: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    },
  };
};

export const encodeFrame = (frame: ClientFrame | ServerFrame): string =>
  JSON.stringify(frame);

export const decodeClientFrame = (raw: string): Decoded<ClientFrame> =>
  decode(clientFrame, raw);

export const decodeServerFrame = (raw: string): Decoded<ServerFrame> =>
  decode(serverFrame, raw);

/** Does this client's version speak this protocol? There is one version and no negotiation yet. */
export const supportsVersion = (version: number): boolean =>
  version === PROTOCOL_VERSION;
