// The protocol server (brief §8): one WebSocket per client on `LOOM_BIND`, authenticated with
// `LOOM_TOKEN`. A client sends `hello`, gets `welcome` and a `snapshot`, then patches with a
// sequence number that is per connection and contiguous, so a gap always means loss.
//
// Human commands are recorded as inputs and acknowledged with their input ID; reconcile decides
// what happens next (principle 3).

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { Task, TaskId } from "@loom/core";
import type {
  Change,
  ClientFrame,
  ServerFrame,
  Subscription,
} from "@loom/protocol";
import {
  CLOSE,
  COLLECTION_FIELDS,
  command as commandSchema,
  decodeClientFrame,
  emptySnapshotBody,
  encodeFrame,
  filterChanges,
  inScope,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ProtocolError,
  scopeOf,
  serverFrame,
  supportsVersion,
  taskInScope,
} from "@loom/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Row } from "./views.js";

export interface ServerCommandResult {
  ok: true;
  result: unknown;
}
export interface ServerCommandError {
  ok: false;
  error: ProtocolError;
}

export interface ProtocolServerDeps {
  token: string;
  instance: string;
  version: string;
  startedAt: string;
  epoch: string;
  heartbeatMs: number;
  bind: { host: string; port: number };
  now(): string;
  /** Everything currently published, used for a snapshot and for a resync. */
  snapshot(scope: readonly Subscription[]): Promise<Row[]>;
  /** A task as published, so a patch can route runs to the lists that asked for them. */
  task(taskId: TaskId): Task | null;
  /** Runs one command and answers with its `ackResult` payload or a typed error. */
  command(value: unknown): Promise<ServerCommandResult | ServerCommandError>;
  /** Asked when a client subscribes to something the coordinator has not published yet. */
  ensure(subscriptions: readonly Subscription[]): Promise<void>;
  onError(error: Error): void;
}

interface Connection {
  socket: WebSocket;
  clientId: string;
  seq: number;
  scope: readonly Subscription[];
  missedPongs: number;
}

const equalTokens = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

const bodyFrom = (rows: readonly Row[]) => {
  const body = emptySnapshotBody();
  for (const entry of rows)
    (body[COLLECTION_FIELDS[entry.collection]] as unknown[]).push(entry.value);
  return body;
};

export class ProtocolServer {
  private readonly connections = new Set<Connection>();
  private wss: WebSocketServer | null = null;
  private http: HttpServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private address: { host: string; port: number } | null = null;
  constructor(private readonly deps: ProtocolServerDeps) {}

  get url(): string | null {
    return this.address
      ? `ws://${this.address.host}:${this.address.port}`
      : null;
  }

  get clients(): number {
    return this.connections.size;
  }

  async start(): Promise<void> {
    const http = createServer((_request, response) => {
      response
        .writeHead(426)
        .end("This endpoint speaks the Loom protocol only");
    });
    const wss = new WebSocketServer({
      server: http,
      maxPayload: MAX_FRAME_BYTES,
    });
    wss.on("connection", (socket, request) => {
      const header = request.headers.authorization;
      this.accept(socket, header?.match(/^Bearer (.+)$/)?.[1] ?? null);
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.deps.bind.port, this.deps.bind.host, resolve);
    });
    const listening = http.address();
    if (!listening || typeof listening === "string")
      throw new Error("The protocol listener has no address");
    this.address = { host: this.deps.bind.host, port: listening.port };
    this.http = http;
    this.wss = wss;
    this.heartbeat = setInterval(() => this.beat(), this.deps.heartbeatMs);
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const connection of this.connections)
      connection.socket.close(CLOSE.goingAway, "shutting down");
    this.connections.clear();
    await new Promise<void>((resolve) =>
      this.wss ? this.wss.close(() => resolve()) : resolve(),
    );
    await new Promise<void>((resolve) =>
      this.http ? this.http.close(() => resolve()) : resolve(),
    );
    this.wss = null;
    this.http = null;
    this.address = null;
  }

  /** One patch per committed reconcile, filtered per connection and numbered per connection. */
  publish(changes: readonly Change[]): void {
    if (!changes.length) return;
    for (const connection of this.connections) {
      const mine = filterChanges(scopeOf(connection.scope), changes, (taskId) =>
        this.deps.task(taskId as TaskId),
      );
      if (!mine.length) continue;
      connection.seq += 1;
      this.send(connection, {
        type: "patch",
        seq: connection.seq,
        now: this.deps.now() as never,
        changes: mine,
      } as ServerFrame);
    }
  }

  /** Forces a gap in one client's stream. Test-only: it proves the client detects loss. */
  skipSequence(clientId: string, by = 1): void {
    for (const connection of this.connections)
      if (connection.clientId === clientId) connection.seq += by;
  }

  private accept(socket: WebSocket, headerToken: string | null): void {
    let connection: Connection | null = null;
    // The token may travel in the `hello` frame or in `Authorization: Bearer`, never in the URL:
    // query strings reach logs and `ps`. Either one matching is enough.
    const authorized = (frameToken: string): boolean =>
      equalTokens(frameToken, this.deps.token) ||
      (headerToken !== null && equalTokens(headerToken, this.deps.token));
    const timer = setTimeout(() => {
      if (!connection) {
        this.fail(socket, null, {
          code: "not_authenticated",
          message: "No hello frame arrived",
          details: [],
        });
        socket.close(CLOSE.handshakeTimeout, "handshake timeout");
      }
    }, 10_000);
    timer.unref?.();
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.fail(socket, null, {
          code: "invalid_frame",
          message: "Binary frames are not part of the protocol",
          details: [],
        });
        socket.close(CLOSE.badFrame, "binary frame");
        return;
      }
      const decoded = decodeClientFrame(String(data));
      if (!decoded.ok) {
        this.fail(socket, null, decoded.error);
        socket.close(CLOSE.badFrame, "bad frame");
        return;
      }
      void this.handle(
        socket,
        decoded.frame,
        connection,
        authorized,
        (value) => {
          connection = value;
          clearTimeout(timer);
        },
      ).catch((error) =>
        this.deps.onError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (connection) this.connections.delete(connection);
    });
    socket.on("error", () => socket.close());
  }

  private async handle(
    socket: WebSocket,
    frame: ClientFrame,
    connection: Connection | null,
    authorized: (frameToken: string) => boolean,
    established: (connection: Connection) => void,
  ): Promise<void> {
    if (frame.type === "hello") {
      if (connection) {
        this.fail(socket, null, {
          code: "already_authenticated",
          message: "This connection already said hello",
          details: [],
        });
        socket.close(CLOSE.badFrame, "second hello");
        return;
      }
      if (!supportsVersion(frame.protocolVersion)) {
        this.fail(socket, null, {
          code: "unsupported_protocol_version",
          message: `This coordinator speaks protocol ${PROTOCOL_VERSION}`,
          details: [`got ${frame.protocolVersion}`],
        });
        socket.close(CLOSE.unsupportedProtocolVersion, "version");
        return;
      }
      if (!authorized(frame.token)) {
        this.fail(socket, null, {
          code: "unauthorized",
          message: "The token was not accepted",
          details: [],
        });
        socket.close(CLOSE.unauthorized, "unauthorized");
        return;
      }
      const value: Connection = {
        socket,
        clientId: frame.client.id,
        // Sequence numbers are positive, so the first snapshot is 1 and the first patch is 2.
        seq: 1,
        scope: frame.subscriptions,
        missedPongs: 0,
      };
      this.connections.add(value);
      established(value);
      this.send(value, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        coordinator: {
          instance: this.deps.instance,
          version: this.deps.version,
          startedAt: this.deps.startedAt as never,
        },
        clientId: value.clientId,
        heartbeatMs: this.deps.heartbeatMs,
        limits: { maxFrameBytes: MAX_FRAME_BYTES, maxSubscriptions: 256 },
      } as ServerFrame);
      await this.sendSnapshot(value, null);
      return;
    }
    if (!connection) {
      this.fail(socket, null, {
        code: "not_authenticated",
        message: "Say hello first",
        details: [],
      });
      socket.close(CLOSE.unauthorized, "not authenticated");
      return;
    }
    switch (frame.type) {
      case "ping":
        this.send(connection, { type: "pong", at: this.deps.now() as never });
        return;
      case "pong":
        connection.missedPongs = 0;
        return;
      case "subscribe": {
        const removed = new Set(frame.remove.map((s) => JSON.stringify(s)));
        const kept = connection.scope.filter(
          (s) => !removed.has(JSON.stringify(s)),
        );
        const known = new Set(kept.map((s) => JSON.stringify(s)));
        connection.scope = [
          ...kept,
          ...frame.add.filter((s) => !known.has(JSON.stringify(s))),
        ];
        await this.deps.ensure(connection.scope);
        this.send(connection, {
          type: "ack",
          requestId: frame.requestId,
          outcome: {
            ok: true,
            result: { kind: "subscribed", scope: [...connection.scope] },
          },
        } as ServerFrame);
        if (frame.wantSnapshot)
          await this.sendSnapshot(connection, frame.requestId);
        return;
      }
      case "resync":
        await this.sendSnapshot(connection, frame.requestId);
        return;
      case "command": {
        const parsed = commandSchema.safeParse(frame.command);
        if (!parsed.success) {
          this.send(connection, {
            type: "ack",
            requestId: frame.requestId,
            outcome: {
              ok: false,
              error: {
                code: "invalid_input",
                message: "The command failed the schema",
                details: parsed.error.issues.map(
                  (i) => `${i.path.join(".") || "command"}: ${i.message}`,
                ),
              },
            },
          } as ServerFrame);
          return;
        }
        const outcome = await this.deps.command(parsed.data);
        this.send(connection, {
          type: "ack",
          requestId: frame.requestId,
          outcome: outcome.ok
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error },
        } as ServerFrame);
        return;
      }
    }
  }

  /** A snapshot names the sequence the patch stream continues from; the client resets to it. */
  private async sendSnapshot(
    connection: Connection,
    requestId: string | null,
  ): Promise<void> {
    await this.deps.ensure(connection.scope);
    const scope = scopeOf(connection.scope);
    const all = await this.deps.snapshot(connection.scope);
    // Runs are judged by the task rows in this same snapshot, so both agree.
    const tasks = new Map<string, Task>();
    for (const entry of all)
      if (entry.collection === "task")
        tasks.set((entry.value as Task).id, entry.value as Task);
    const rows = all.filter((entry) =>
      entry.collection === "task"
        ? taskInScope(scope, entry.value as never) ||
          scope.tasks.has((entry.value as { id: string }).id)
        : inScope(
            scope,
            {
              op: "upsert",
              collection: entry.collection,
              value: entry.value,
            } as Change,
            (taskId) => tasks.get(taskId) ?? null,
          ),
    );
    this.send(connection, {
      type: "snapshot",
      seq: connection.seq,
      now: this.deps.now() as never,
      epoch: this.deps.epoch,
      requestId,
      scope: [...connection.scope],
      body: bodyFrom(rows),
    } as ServerFrame);
  }

  private beat(): void {
    for (const connection of [...this.connections]) {
      if (connection.missedPongs >= 3) {
        connection.socket.close(CLOSE.heartbeatTimeout, "missed heartbeats");
        this.connections.delete(connection);
        continue;
      }
      connection.missedPongs += 1;
      this.send(connection, { type: "ping", at: this.deps.now() as never });
    }
  }

  private fail(
    socket: WebSocket,
    requestId: string | null,
    error: ProtocolError,
  ): void {
    socket.send(
      encodeFrame({
        type: "error",
        requestId,
        error,
        fatal: true,
      } as ServerFrame),
    );
  }

  private send(connection: Connection, frame: ServerFrame): void {
    try {
      // Validate on the way out too: a frame a client cannot parse is a coordinator bug, and it
      // would otherwise present as a window that silently stops updating.
      connection.socket.send(encodeFrame(serverFrame.parse(frame)));
    } catch (error) {
      this.deps.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
