import type {
  AckOutcome,
  ClientFrame,
  ClientState,
  Command,
  PatchFrame,
  Subscription,
} from "@loom/protocol";
import {
  applyPatch,
  command as commandSchema,
  decodeServerFrame,
  encodeFrame,
  PROTOCOL_VERSION,
  stateFromSnapshot,
} from "@loom/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected";
interface Options {
  url: string;
  token: string;
  instance: string;
  clientId: string;
  onState(state: ClientState, patch?: PatchFrame): void;
  onStatus(status: ConnectionStatus, message?: string): void;
  retryMs?: number;
}
const unavailable = (message: string): AckOutcome => ({
  ok: false,
  error: { code: "unavailable", message, details: [] },
});

/** One disposable window client. Reconnect always replaces state; commands are never replayed. */
export class TrackerClient {
  private socket: WebSocket | null = null;
  private state: ClientState | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private sequence = 0;
  private ready = false;
  private welcomed = false;
  private resyncing = false;
  private heartbeatMs = 10_000;
  private detail: Subscription[] = [];
  private sentDetail: Subscription[] = [];
  private pending = new Map<
    string,
    { resolve(outcome: AckOutcome): void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(private readonly options: Options) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
    this.ready = false;
    this.socket?.close();
    this.failPending();
  }
  private send(frame: ClientFrame): void {
    this.socket?.send(encodeFrame(frame));
  }
  private id(): string {
    return `${this.options.clientId}-${++this.sequence}`;
  }
  private failPending(): void {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(
        unavailable(
          "Connection lost; outcome unknown. Check issue activity before retrying.",
        ),
      );
    }
    this.pending.clear();
  }
  command(value: Command): Promise<AckOutcome> {
    const parsed = commandSchema.safeParse(value);
    if (!parsed.success)
      return Promise.resolve({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Check the command fields",
          details: [],
        },
      });
    if (!this.ready)
      return Promise.resolve(
        unavailable("Disconnected; command was not sent."),
      );
    const requestId = this.id();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(
          unavailable(
            "No acknowledgement; outcome unknown. Check issue activity before retrying.",
          ),
        );
      }, 30_000);
      this.pending.set(requestId, { resolve, timer });
      this.send({ type: "command", requestId, command: parsed.data });
    });
  }
  setDetail(detail: Subscription[]): void {
    this.detail = detail;
    this.syncDetail();
  }
  private syncDetail(): void {
    if (
      !this.ready ||
      JSON.stringify(this.detail) === JSON.stringify(this.sentDetail)
    )
      return;
    const remove = this.sentDetail;
    this.sentDetail = this.detail;
    this.send({
      type: "subscribe",
      requestId: this.id(),
      add: this.detail,
      remove,
      wantSnapshot: true,
    });
  }
  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () => this.socket?.close(),
      this.heartbeatMs * 3,
    );
  }
  private connect(): void {
    if (this.stopped) return;
    this.options.onStatus(this.attempts ? "disconnected" : "connecting");
    this.ready = false;
    this.welcomed = false;
    this.resyncing = false;
    this.state = null;
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    this.armWatchdog();
    socket.addEventListener("open", () => {
      if (this.stopped || socket !== this.socket) return socket.close();
      this.sentDetail = this.detail;
      this.send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: this.options.token,
        client: {
          id: this.options.clientId,
          kind: "tracker",
          name: "Loom",
          version: "0.0.0",
        },
        subscriptions: [
          { kind: "views", views: ["all"], repoIds: null },
          ...this.detail,
        ],
      });
    });
    socket.addEventListener("message", (event) => {
      if (this.stopped || socket !== this.socket) return;
      const decoded =
        typeof event.data === "string" ? decodeServerFrame(event.data) : null;
      if (!decoded?.ok) {
        this.options.onStatus("disconnected", "Invalid coordinator frame");
        socket.close();
        return;
      }
      const frame = decoded.frame;
      this.armWatchdog();
      if (frame.type === "welcome") {
        if (
          frame.coordinator.instance !== this.options.instance ||
          frame.protocolVersion !== PROTOCOL_VERSION
        ) {
          this.options.onStatus(
            "disconnected",
            "Coordinator instance or version does not match",
          );
          socket.close();
          return;
        }
        this.welcomed = true;
        this.heartbeatMs = frame.heartbeatMs;
        this.armWatchdog();
      } else if (frame.type === "snapshot" && this.welcomed) {
        this.state = stateFromSnapshot(frame, frame.body);
        this.resyncing = false;
        this.ready = true;
        this.attempts = 0;
        this.options.onState(this.state);
        this.syncDetail();
        this.options.onStatus("connected");
      } else if (frame.type === "patch" && this.state && !this.resyncing) {
        const result = applyPatch(this.state, frame);
        if (result.ok) this.options.onState(this.state, frame);
        else if (result.reason === "sequence_gap") {
          this.resyncing = true;
          this.ready = false;
          this.options.onStatus("connecting", "Refreshing snapshot");
          this.send({
            type: "resync",
            requestId: this.id(),
            reason: "sequence_gap",
            haveSeq: this.state.seq,
          });
        }
      } else if (frame.type === "ping")
        this.send({ type: "pong", at: frame.at });
      else if (frame.type === "ack") {
        const pending = this.pending.get(frame.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(frame.outcome);
          this.pending.delete(frame.requestId);
        }
      } else if (frame.type === "error") {
        this.options.onStatus("disconnected", frame.error.message);
        if (frame.fatal) socket.close();
      }
    });
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      clearTimeout(this.watchdog);
      this.ready = false;
      this.failPending();
      if (this.stopped) return;
      this.options.onStatus("disconnected");
      const delay = Math.min(
        30_000,
        (this.options.retryMs ?? 500) * 2 ** Math.min(this.attempts++, 8),
      );
      this.retry = setTimeout(() => this.connect(), delay);
    });
  }
}
