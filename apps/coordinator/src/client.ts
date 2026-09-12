// A protocol client. The CLI is one, and so are the tests' fake windows: it holds no durable
// state, so a dropped connection costs a reconnect and a fresh snapshot and nothing else.

import type {
  AckOutcome,
  ClientState,
  Command,
  ServerFrame,
  Subscription,
} from "@loom/protocol";
import {
  applyPatch,
  decodeServerFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  stateFromSnapshot,
} from "@loom/protocol";

export interface ClientOptions {
  url: string;
  token: string;
  clientId: string;
  kind: "tracker" | "workbench" | "cli" | "web";
  name?: string;
  version?: string;
  subscriptions?: Subscription[];
  /** Called when the stream lost frames. The default asks for a fresh snapshot. */
  onGap?: (client: LoomClient, expected: number) => void;
  onError?: (message: string) => void;
}

type Waiter = (frame: ServerFrame) => boolean;

export class LoomClient {
  state: ClientState | null = null;
  readonly gaps: { expected: number; received: number }[] = [];
  /** The last `error` frame's message, so a refused handshake says why it was refused. */
  lastError: string | null = null;
  private readonly waiters = new Set<Waiter>();
  private readonly acks = new Map<string, (outcome: AckOutcome) => void>();
  private sequence = 0;
  private constructor(
    private readonly socket: WebSocket,
    private readonly options: ClientOptions,
  ) {}

  static async connect(options: ClientOptions): Promise<LoomClient> {
    const socket = new WebSocket(options.url);
    const client = new LoomClient(socket, options);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () =>
        reject(new Error(`Could not reach the coordinator at ${options.url}`)),
      );
      socket.addEventListener("open", () => resolve());
    });
    socket.addEventListener("message", (event) => client.receive(event.data));
    // The handshake can be refused: the coordinator sends one `error` frame and closes.
    let handshaking = true;
    const refused = new Promise<never>((_, reject) => {
      socket.addEventListener("close", (event) => {
        if (handshaking)
          reject(
            new Error(
              client.lastError ??
                `The coordinator closed the socket (${event.code})`,
            ),
          );
      });
    });
    refused.catch(() => undefined);
    const welcome = client.await((frame) => frame.type === "welcome");
    const snapshot = client.await((frame) => frame.type === "snapshot");
    client.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      token: options.token,
      client: {
        id: options.clientId,
        kind: options.kind,
        name: options.name ?? "loom",
        version: options.version ?? "0.0.0",
      },
      subscriptions: options.subscriptions ?? [],
    });
    try {
      await Promise.race([Promise.all([welcome, snapshot]), refused]);
    } finally {
      handshaking = false;
    }
    return client;
  }

  /** Sends a command and resolves with its single acknowledgement. */
  async command(command: Command): Promise<AckOutcome> {
    const requestId = `r${++this.sequence}`;
    const outcome = new Promise<AckOutcome>((resolve) =>
      this.acks.set(requestId, resolve),
    );
    this.send({ type: "command", requestId, command });
    return outcome;
  }

  async subscribe(add: Subscription[], wantSnapshot = true): Promise<void> {
    const requestId = `r${++this.sequence}`;
    const done = this.await(
      (frame) => frame.type === "ack" && frame.requestId === requestId,
    );
    const snapshot = wantSnapshot
      ? this.await((frame) => frame.type === "snapshot")
      : Promise.resolve();
    this.send({ type: "subscribe", requestId, add, remove: [], wantSnapshot });
    await done;
    await snapshot;
  }

  /** The only recovery from a gap: a fresh snapshot, never a half-applied stream. */
  async resync(
    reason: "sequence_gap" | "reconnect" | "client_request",
  ): Promise<void> {
    const requestId = `r${++this.sequence}`;
    const snapshot = this.await((frame) => frame.type === "snapshot");
    this.send({
      type: "resync",
      requestId,
      reason,
      haveSeq: this.state && this.state.seq > 0 ? this.state.seq : null,
    });
    await snapshot;
  }

  /** Resolves when a frame the predicate accepts arrives. */
  await(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    return new Promise<ServerFrame>((resolve) => {
      const waiter: Waiter = (frame) => {
        if (!predicate(frame)) return false;
        this.waiters.delete(waiter);
        resolve(frame);
        return true;
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    this.socket.close();
  }

  private receive(raw: unknown): void {
    const decoded = decodeServerFrame(String(raw));
    if (!decoded.ok) {
      this.options.onError?.(decoded.error.message);
      return;
    }
    const frame = decoded.frame;
    if (frame.type === "snapshot")
      this.state = stateFromSnapshot(frame, frame.body);
    else if (frame.type === "patch" && this.state) {
      const applied = applyPatch(this.state, frame);
      if (!applied.ok && applied.reason === "sequence_gap") {
        this.gaps.push({
          expected: applied.expected,
          received: applied.received,
        });
        if (this.options.onGap) this.options.onGap(this, applied.expected);
        else void this.resync("sequence_gap");
      }
    } else if (frame.type === "ping") this.send({ type: "pong", at: frame.at });
    else if (frame.type === "ack") {
      this.acks.get(frame.requestId)?.(frame.outcome);
      this.acks.delete(frame.requestId);
    } else if (frame.type === "error")
      this.options.onError?.(frame.error.message);
    for (const waiter of [...this.waiters]) waiter(frame);
  }

  private send(frame: Parameters<typeof encodeFrame>[0]): void {
    this.socket.send(encodeFrame(frame));
  }
}
