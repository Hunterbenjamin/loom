import type {
  ClaudeAdapter,
  ClaudeSessionObservation,
  CodexAdapter,
  CodexThreadObservation,
  Hint,
  IsoTime,
  OnHint,
  ProviderSessionId,
  Run,
  RunObservation,
  WorktreePath,
} from "@loom/core";
import type { FakeClock } from "./clock.js";

export class Hints {
  private listeners = new Set<OnHint>();
  private last: Hint | null = null;
  subscribe = (listener: OnHint) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(hint: Hint) {
    this.last = structuredClone(hint);
    for (const listener of this.listeners) listener(structuredClone(hint));
  }
  duplicate() {
    if (!this.last) throw new Error("No provider event to duplicate");
    this.emit(this.last);
  }
}
export interface Delivery {
  text: string;
  turnId: string;
  steer: boolean;
}
export interface FakeSession {
  cwd: WorktreePath;
  value: CodexThreadObservation | ClaudeSessionObservation;
  activityAt: IsoTime | null;
  resumable: boolean;
  connected: boolean;
  queue: Delivery[];
  dropDelivery: boolean;
  answer: "accept" | "decline" | "answer" | null;
}
export class FakeProviders {
  readonly sessions = new Map<ProviderSessionId, FakeSession>();
  readonly hints = new Hints();
  private sequence = 0;
  private connection: number | null = 1;
  private lastGeneration = 1;
  constructor(
    readonly clock: FakeClock,
    readonly hash: (text: string) => string,
  ) {}
  get(id: ProviderSessionId): FakeSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown fake session ${id}`);
    return s;
  }
  create(
    provider: Run["provider"],
    cwd: WorktreePath,
    id = `fake-session-${++this.sequence}` as ProviderSessionId,
    mode: Run["mode"] = "headless",
  ): ProviderSessionId {
    if (this.sessions.has(id)) return id;
    const value: FakeSession["value"] =
      provider === "codex"
        ? {
            provider,
            threadId: id,
            generation: this.connection ?? this.lastGeneration,
            status: "idle",
            activeFlags: [],
            turns: [],
            lastError: null,
            pendingRequests: [],
            rateLimits: { usageAllowed: true, resetsAt: null },
          }
        : {
            provider,
            sessionId: id,
            agentsEntry: {
              sessionId: id,
              status: "idle",
              rawStatus: "idle",
              kind: mode === "interactive" ? "interactive" : "other",
              pid: 80000 + ++this.sequence,
              cwd,
            },
            hooks: {
              lastEventAt: this.clock.now(),
              pendingDialog: null,
              promptSubmits: [],
              lastStop: null,
              stopFailure: null,
              sessionStart: { source: "startup", at: this.clock.now() },
              sessionEnd: null,
            },
            headless:
              mode === "headless"
                ? { exited: false, exitCode: null, error: null }
                : null,
          };
    this.sessions.set(id, {
      cwd,
      value,
      activityAt: this.clock.now(),
      resumable: true,
      connected: true,
      queue: [],
      dropDelivery: false,
      answer: null,
    });
    return id;
  }
  event(id: ProviderSessionId) {
    const s = this.get(id);
    s.activityAt = this.clock.now();
    if (s.value.provider === "claude")
      s.value.hooks.lastEventAt = this.clock.now();
    this.hints.emit({
      source: s.value.provider === "codex" ? "codex" : "claude_hook",
      sessionId: id,
      worktreePath: s.cwd,
    });
  }
  enqueue(
    id: ProviderSessionId,
    text: string,
    expectedTurnId?: string,
  ): string {
    const s = this.get(id);
    if (!s.connected) throw new Error("Fake provider is disconnected");
    if (
      expectedTurnId &&
      (s.value.provider !== "codex" ||
        s.value.turns.at(-1)?.id !== expectedTurnId ||
        s.value.turns.at(-1)?.status !== "inProgress")
    )
      throw new Error("Stale expected turn");
    const turnId = expectedTurnId ?? `turn-${++this.sequence}`;
    s.queue.push({ text, turnId, steer: !!expectedTurnId });
    return turnId; // Transport acknowledgement has no observation side effect.
  }
  confirm(id: ProviderSessionId): Delivery | null {
    const s = this.get(id);
    const message = s.queue.shift();
    if (!message || s.dropDelivery) return null;
    const hash = this.hash(
      message.text.replace(/\r\n/g, "\n").replace(/\t/g, "    "),
    );
    if (s.value.provider === "codex") {
      s.value.status = "active";
      s.value.lastError = null;
      if (message.steer) s.value.turns.at(-1)?.userMessageHashes.push(hash);
      else
        s.value.turns.push({
          id: message.turnId,
          status: "inProgress",
          error: null,
          userMessageHashes: [hash],
        });
    } else {
      if (!s.value.agentsEntry) throw new Error("Claude session has vanished");
      s.value.agentsEntry.status = s.value.agentsEntry.rawStatus = "busy";
      s.value.hooks.promptSubmits.push({
        promptId: message.turnId,
        textHash: hash,
        at: this.clock.now(),
      });
      s.value.hooks.stopFailure = null;
    }
    this.event(id);
    return message;
  }
  status(id: ProviderSessionId, status: "working" | "idle") {
    const s = this.get(id);
    if (s.value.provider === "codex") {
      s.value.status = status === "working" ? "active" : "idle";
      if (status === "working" && !s.value.turns.length)
        s.value.turns.push({
          id: `turn-${++this.sequence}`,
          status: "inProgress",
          error: null,
          userMessageHashes: [],
        });
    } else if (s.value.agentsEntry)
      s.value.agentsEntry.status = s.value.agentsEntry.rawStatus =
        status === "working" ? "busy" : "idle";
    this.event(id);
  }
  finish(
    id: ProviderSessionId,
    outcome: "completed" | "interrupted" | "failed",
    error?: { kind: string; willRetry: boolean },
  ) {
    const s = this.get(id);
    if (s.value.provider === "codex") {
      const turn = s.value.turns.at(-1);
      if (!turn) throw new Error("No turn to finish");
      const kind = error?.kind;
      const nativeError: CodexThreadObservation["lastError"] = error
        ? {
            message: error.kind,
            willRetry: error.willRetry,
            kind:
              kind === "rateLimitExceeded" ||
              kind === "usageLimitExceeded" ||
              kind === "serverOverloaded"
                ? kind
                : ("other" as const),
          }
        : null;
      turn.status = outcome;
      turn.error = nativeError;
      s.value.lastError = nativeError;
      s.value.status = outcome === "failed" ? "systemError" : "idle";
    } else {
      if (s.value.headless) {
        s.value.headless.completedTurns =
          (s.value.headless.completedTurns ?? 0) + 1;
        s.value.headless.lastTurn = {
          outcome: outcome === "completed" ? "completed" : "failed",
          error: outcome === "completed" ? null : (error?.kind ?? outcome),
        };
      }
      if (s.value.agentsEntry)
        s.value.agentsEntry.status = s.value.agentsEntry.rawStatus = "idle";
      if (outcome === "completed")
        s.value.hooks.lastStop = {
          promptId: s.value.hooks.promptSubmits.at(-1)?.promptId ?? "prompt-0",
          at: this.clock.now(),
          lastAssistantMessage: null,
        };
      if (outcome === "failed")
        s.value.hooks.stopFailure = {
          error: error?.kind ?? "failed",
          at: this.clock.now(),
        };
    }
    this.event(id);
  }
  crash(id: ProviderSessionId) {
    const s = this.get(id);
    if (s.value.provider === "codex") {
      s.connected = false;
      this.connection = null;
    } else {
      s.value.agentsEntry = null;
      if (s.value.headless)
        s.value.headless = { exited: true, exitCode: 1, error: "crashed" };
    }
    // A crash has no native activity or Claude SessionEnd.
    this.hints.emit({
      source: s.value.provider === "codex" ? "codex" : "claude_hook",
      sessionId: id,
      worktreePath: s.cwd,
    });
  }
  recover(id: ProviderSessionId) {
    const s = this.get(id);
    if (!s.resumable) throw new Error("Session cannot resume");
    s.connected = true;
    s.queue = [];
    if (s.value.provider === "codex") {
      if (this.connection === null) this.connection = ++this.lastGeneration;
      s.value.generation = this.connection;
      s.value.pendingRequests = [];
      s.value.activeFlags = [];
      const turn = s.value.turns.at(-1);
      if (turn?.status === "inProgress") turn.status = "interrupted";
      s.value.status = "idle";
      s.value.lastError = null;
    } else {
      s.value.agentsEntry = {
        sessionId: id,
        status: "idle",
        rawStatus: "idle",
        kind: s.value.headless ? "other" : "interactive",
        pid: 80000 + ++this.sequence,
        cwd: s.cwd,
      };
      if (s.value.headless)
        s.value.headless = { exited: false, exitCode: null, error: null };
      s.value.hooks.stopFailure = null;
      s.value.hooks.sessionEnd = null;
      s.value.hooks.sessionStart = { source: "resume", at: this.clock.now() };
    }
    this.event(id);
  }
  request(
    id: ProviderSessionId,
    kind: "approval" | "question",
    summary: string,
  ) {
    const s = this.get(id);
    s.answer = null;
    if (s.value.provider === "codex") {
      s.value.activeFlags = [
        kind === "approval" ? "waitingOnApproval" : "waitingOnUserInput",
      ];
      s.value.pendingRequests = [
        {
          requestId: `request-${++this.sequence}`,
          kind: kind === "approval" ? "command_approval" : "question",
          isBlocking: true,
          summary,
          receivedAt: this.clock.now(),
        },
      ];
    } else {
      if (s.value.headless)
        s.value.headless.completedTurns =
          (s.value.headless.completedTurns ?? 0) + 1;
      if (s.value.agentsEntry)
        s.value.agentsEntry.status = s.value.agentsEntry.rawStatus = "waiting";
      s.value.hooks.pendingDialog = {
        kind: kind === "approval" ? "permission" : "input",
        tool: kind === "approval" ? "Bash" : "AskUserQuestion",
        at: this.clock.now(),
      };
    }
    this.event(id);
  }
  answer(id: ProviderSessionId, answer: "accept" | "decline" | "answer") {
    const s = this.get(id);
    s.answer = answer;
    if (s.value.provider === "codex") {
      s.value.pendingRequests = [];
      s.value.activeFlags = [];
    } else s.value.hooks.pendingDialog = null;
    this.status(id, "working");
  }
  rateLimit(id: ProviderSessionId, ms: number) {
    const s = this.get(id);
    if (s.value.provider === "codex")
      s.value.rateLimits = {
        usageAllowed: false,
        resetsAt: new Date(
          Date.parse(this.clock.now()) + ms,
        ).toISOString() as IsoTime,
      };
    else
      s.value.hooks.stopFailure = { error: "rate_limit", at: this.clock.now() };
    this.event(id);
    this.clock.after(ms, () => {
      if (s.value.provider === "codex") {
        s.value.rateLimits = { usageAllowed: true, resetsAt: null };
        s.value.lastError = null;
      } else s.value.hooks.stopFailure = null;
      this.status(id, "idle");
    });
  }
  observe(run: Run): RunObservation {
    const s = run.sessionId ? this.sessions.get(run.sessionId) : undefined;
    return {
      runId: run.id,
      pane: null,
      resumable: s?.resumable ?? null,
      activityAt: s?.activityAt ?? null,
      provider:
        s && !s.connected
          ? {
              ok: false,
              at: this.clock.now(),
              reason: "Fake connection closed",
            }
          : {
              ok: true,
              at: this.clock.now(),
              value: s ? structuredClone(s.value) : null,
            },
    };
  }
  readonly codex: CodexAdapter = {
    startServer: async () => {
      if (this.connection === null) this.connection = ++this.lastGeneration;
    },
    stopServer: async () => {
      for (const [id, s] of this.sessions)
        if (s.value.provider === "codex") this.crash(id);
      this.connection = null;
    },
    reconnect: async () => {
      if (this.connection === null) this.connection = ++this.lastGeneration;
    },
    generation: () => this.connection,
    checkResumable: async (id) => this.sessions.get(id)?.resumable ?? false,
    activityAt: (id) => this.sessions.get(id)?.activityAt ?? null,
    startThread: async (req) => ({
      threadId: this.create("codex", req.cwd),
      generation: this.connection ?? this.lastGeneration,
    }),
    startTurn: async (req) => ({
      turnId: this.enqueue(req.threadId, req.text),
    }),
    steerTurn: async (req) => ({
      turnId: this.enqueue(req.threadId, req.text, req.expectedTurnId),
    }),
    interruptTurn: async (req) => {
      const s = this.get(req.threadId);
      if (
        s.value.provider !== "codex" ||
        s.value.turns.at(-1)?.id !== req.turnId
      )
        throw new Error("Stale interrupt");
      this.finish(req.threadId, "interrupted");
    },
    readThread: async (id) => {
      const s = this.get(id);
      if (!s.connected || s.value.provider !== "codex")
        throw new Error("Thread unavailable");
      return structuredClone(s.value);
    },
    resumeThread: async (id) => {
      const s = this.get(id);
      if (s.value.provider !== "codex") throw new Error("Wrong provider");
      if (!s.connected || s.value.status === "notLoaded") this.recover(id);
      return structuredClone(s.value);
    },
    unsubscribe: async () => {},
    answerRequest: async (req) => {
      const s = this.get(req.threadId);
      if (
        req.generation !== this.connection ||
        s.value.provider !== "codex" ||
        !s.value.pendingRequests.some((r) => r.requestId === req.requestId)
      )
        throw new Error("Stale provider request");
      this.answer(
        req.threadId,
        req.answers
          ? "answer"
          : req.decision === "accept"
            ? "accept"
            : "decline",
      );
    },
    readRateLimits: async () => {
      for (const s of this.sessions.values())
        if (
          s.value.provider === "codex" &&
          s.value.rateLimits?.usageAllowed === false
        )
          return structuredClone(s.value.rateLimits);
      return { usageAllowed: true, resetsAt: null };
    },
    attachArgs: (id) => [
      "fake-codex",
      "resume",
      id,
      "--remote",
      "unix:///fake/loom-codex.sock",
    ],
    subscribe: this.hints.subscribe,
  };
  readonly claude: ClaudeAdapter = {
    listSessions: async () =>
      [...this.sessions.values()].flatMap((s) =>
        s.value.provider === "claude" && s.value.agentsEntry
          ? [structuredClone(s.value.agentsEntry)]
          : [],
      ),
    hookSummary: async (id) => {
      const v = this.get(id).value;
      if (v.provider !== "claude") throw new Error("Wrong provider");
      return structuredClone(v.hooks);
    },
    writeSettings: async () => {},
    interactiveArgs: (req) => [
      "fake-claude",
      req.resume ? "--resume" : "--session-id",
      req.sessionId,
      "--model",
      req.model,
      "--settings",
      req.settingsPath,
    ],
    startHeadless: async (req) => {
      const existing = this.sessions.get(req.sessionId);
      if (
        existing?.value.provider === "claude" &&
        existing.value.agentsEntry &&
        !existing.value.headless?.exited
      )
        return;
      const exists = !!existing;
      this.create("claude", req.cwd, req.sessionId);
      if (exists && req.resume) {
        if (existing.value.provider === "claude")
          existing.value.headless = {
            exited: false,
            exitCode: null,
            error: null,
          };
        this.recover(req.sessionId);
      }
      if (req.prompt) this.enqueue(req.sessionId, req.prompt);
    },
    sendHeadless: async (req) => {
      this.enqueue(req.sessionId, req.text);
    },
    stopHeadless: async (id) => {
      const s = this.sessions.get(id);
      if (s?.value.provider === "claude") {
        s.value.agentsEntry = null;
        s.value.headless = { exited: true, exitCode: 0, error: null };
      }
    },
    interruptHeadless: async (id) => {
      this.finish(id, "interrupted");
    },
    closeHeadless: async (id) => {
      const session = this.sessions.get(id);
      if (session?.value.provider !== "claude" || !session.value.headless)
        return;
      session.queue = [];
      session.value.agentsEntry = null;
      session.value.headless = null;
      this.event(id);
    },
    headlessState: async (id) => {
      const found = this.sessions.get(id);
      if (!found) return null;
      const v = found.value;
      if (v.provider !== "claude") throw new Error("Wrong provider");
      return structuredClone(v.headless);
    },
    resumable: async (id) => this.sessions.get(id)?.resumable ?? false,
    activityAt: async (id) => this.sessions.get(id)?.activityAt ?? null,
    subscribe: this.hints.subscribe,
  };
}
