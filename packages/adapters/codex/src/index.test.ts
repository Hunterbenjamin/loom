import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  CodexAdapter,
  Hint,
  ProviderSessionId,
  WorktreePath,
} from "@loom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeServer } from "./fake-server.js";
import {
  codexMcpServer,
  createCodexAdapter,
  StaleCodexRequestError,
} from "./index.js";

describe("codexMcpServer", () => {
  it("translates an HTTP registration to Codex's http_headers key", () => {
    expect(
      codexMcpServer({
        type: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer t" },
      }),
    ).toEqual({
      url: "http://127.0.0.1:1/mcp",
      http_headers: { Authorization: "Bearer t" },
    });
    expect(
      codexMcpServer({ type: "http", url: "http://127.0.0.1:1/mcp" }),
    ).toEqual({ url: "http://127.0.0.1:1/mcp" });
  });
  it("passes a stdio registration through", () => {
    expect(
      codexMcpServer({
        command: "loom-mcp",
        args: ["--stdio"],
        env: { A: "1" },
      }),
    ).toEqual({ command: "loom-mcp", args: ["--stdio"], env: { A: "1" } });
  });
});

const traffic = JSON.parse(
  await readFile(new URL("./fixtures/traffic.json", import.meta.url), "utf8"),
);
const threadId = traffic.thread.id as ProviderSessionId;
const turnId = traffic.thread.turns[0].id as string;
let fake: Awaited<ReturnType<typeof fakeServer>>;
let adapter: CodexAdapter;
let thread: typeof traffic.thread;
let replayApproval: boolean;
/** What the fake answers `thread/read` with: the thread, or an RPC error message. */
let readError: string | null;
const answer = (generation: number) => ({
  threadId,
  generation,
  requestId: "0",
  decision: "accept" as const,
  answers: null,
});

beforeEach(async () => {
  fake = await fakeServer();
  thread = structuredClone(traffic.thread);
  thread.cwd = fake.directory;
  replayApproval = false;
  readError = null;
  fake.handle((method, params, socket) => {
    switch (method) {
      case "thread/start":
        return { result: { thread: { ...thread, turns: [] } } };
      case "thread/resume":
        if (replayApproval) socket.send(JSON.stringify(traffic.approval));
        return { result: { thread } };
      case "thread/read":
        return readError
          ? { error: { code: -32600, message: readError } }
          : { result: { thread } };
      case "turn/start":
        return { result: { turn: { id: turnId, status: "inProgress" } } };
      case "turn/steer":
        return params.expectedTurnId === turnId
          ? { result: { turnId } }
          : { error: traffic.wrongTurn };
      case "turn/interrupt":
        return { result: {} };
      case "thread/unsubscribe":
        return { result: { status: "unsubscribed" } };
      case "account/rateLimits/read":
        return { result: traffic.limits };
      default:
        throw new Error(`Unhandled fake method ${method}`);
    }
  });
  adapter = createCodexAdapter({
    taskDirectory: fake.directory,
    timeoutMs: 2000,
  });
  await adapter.reconnect();
});
afterEach(async () => {
  await adapter.stopServer();
  await fake.close();
});

describe("Codex app-server adapter", () => {
  it("initializes Unix WebSocket with the experimental handshake before any RPC", async () => {
    const result = await adapter.startThread({
      cwd: fake.directory as WorktreePath,
      model: "gpt-5.6-luna",
      sandbox: "read-only",
      developerInstructions: "Fixture only",
      config: {},
    });
    expect(result).toEqual({ threadId, generation: 1 });
    expect(fake.headers[0]).toEqual({
      host: "localhost",
      extension: undefined,
      url: "/rpc",
    });
    expect(
      fake.messages.slice(0, 3).map((entry) => entry.message),
    ).toMatchObject([
      {
        method: "initialize",
        params: { capabilities: { experimentalApi: true } },
      },
      { method: "initialized" },
      {
        method: "thread/start",
        params: {
          model: "gpt-5.6-luna",
          sandbox: "read-only",
          ephemeral: false,
          historyMode: "legacy",
          approvalsReviewer: "user",
        },
      },
    ]);
    expect(adapter.attachArgs(threadId)).toEqual([
      "codex",
      "resume",
      threadId,
      "--remote",
      `unix://${fake.directory}/app-server.sock`,
    ]);
  });
  it("hydrates resume and hashes normalized user-message items without making a transition", async () => {
    const snapshot = await adapter.resumeThread(threadId);
    expect(snapshot).toMatchObject({
      threadId,
      generation: 1,
      status: "active",
      activeFlags: ["waitingOnApproval"],
    });
    expect(snapshot.turns[0]?.userMessageHashes).toEqual([
      createHash("sha256").update("A    B\nC").digest("hex"),
    ]);
    expect(await adapter.readThread(threadId)).toEqual(snapshot);
  });
  it("surfaces a replayed pending approval without answering it and waits for resolution", async () => {
    replayApproval = true;
    const snapshot = await adapter.resumeThread(threadId);
    expect(snapshot.pendingRequests).toMatchObject([
      {
        requestId: "0",
        kind: "command_approval",
        isBlocking: null,
        summary: "touch /tmp/loom-fixture",
      },
    ]);
    expect(
      fake.messages.some((entry) => "result" in (entry.message as object)),
    ).toBe(false);
    await adapter.answerRequest(answer(1));
    await adapter.answerRequest(answer(1));
    expect((await adapter.readThread(threadId)).pendingRequests).toHaveLength(
      1,
    );
    expect(
      fake.messages.filter((entry) => "result" in (entry.message as object)),
    ).toHaveLength(1);
    fake.broadcast({
      method: "serverRequest/resolved",
      params: { threadId, requestId: 0 },
    });
    await vi.waitFor(async () =>
      expect((await adapter.readThread(threadId)).pendingRequests).toEqual([]),
    );
    await expect(adapter.answerRequest(answer(1))).rejects.toThrow(
      StaleCodexRequestError,
    );
  });
  it("increments generation on reconnect, rejects old approval IDs, and requires rehydration", async () => {
    replayApproval = true;
    await adapter.resumeThread(threadId);
    await adapter.reconnect();
    expect(adapter.generation()).toBe(2);
    await expect(adapter.readThread(threadId)).rejects.toThrow("Resume thread");
    await adapter.resumeThread(threadId);
    await expect(adapter.answerRequest(answer(1))).rejects.toThrow("Stale");
    await adapter.answerRequest(answer(2));
  });
  it("sends normalized turns, passes expectedTurnId to steer, and propagates a mismatch", async () => {
    expect(await adapter.startTurn({ threadId, text: "A\tB\r\nC" })).toEqual({
      turnId,
    });
    expect(
      await adapter.steerTurn({
        threadId,
        expectedTurnId: turnId,
        text: "steer",
      }),
    ).toEqual({ turnId });
    await expect(
      adapter.steerTurn({ threadId, expectedTurnId: "wrong", text: "steer" }),
    ).rejects.toThrow("expectedTurnId");
    expect(fake.messages.map((entry) => entry.message)).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "A    B\nC", text_elements: [] }],
        },
      }),
    );
  });
  it("passes pinned model and reasoning to turn/start", async () => {
    await adapter.startTurn({
      threadId,
      text: "continue",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    expect(fake.messages.map((entry) => entry.message)).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          model: "gpt-5.6-sol",
          effort: "medium",
        }),
      }),
    );
  });
  it("interrupts only the specified turn and unsubscribes without stopping a server", async () => {
    await adapter.resumeThread(threadId);
    await adapter.interruptTurn({ threadId, turnId });
    await adapter.unsubscribe(threadId);
    expect(adapter.generation()).toBe(1);
    expect(fake.messages.map((entry) => entry.message)).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: { threadId, turnId },
      }),
    );
    await expect(adapter.readThread(threadId)).rejects.toThrow("Resume");
  });
  it("reads allowance from the backend boolean and the latest exhausted-window reset", async () => {
    expect(await adapter.readRateLimits()).toEqual({
      usageAllowed: false,
      resetsAt: new Date(1789300000 * 1000).toISOString(),
    });
    fake.handle(() => ({
      result: { ...traffic.limits, ordinaryUsageAllowed: true },
    }));
    expect((await adapter.readRateLimits()).usageAllowed).toBe(true);
    fake.handle(() => ({
      result: { ...traffic.limits, ordinaryUsageAllowed: null },
    }));
    await expect(adapter.readRateLimits()).rejects.toThrow("unavailable");
  });
  it("emits hints for quota and activity notifications without treating them as snapshots", async () => {
    await adapter.resumeThread(threadId);
    const hints: Hint[] = [];
    const unsubscribe = adapter.subscribe((hint) => hints.push(hint));
    fake.broadcast({
      method: "account/rateLimits/updated",
      params: { ordinaryUsageAllowed: false },
    });
    fake.broadcast({
      method: "thread/status/changed",
      params: { threadId, status: { type: "idle" } },
    });
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    const snapshot = await adapter.readThread(threadId);
    expect(snapshot.status).toBe("active");
    expect(snapshot.rateLimits).toBeNull();
    expect(hints[1]).toMatchObject({
      source: "codex",
      sessionId: threadId,
      worktreePath: expect.stringContaining("loom-codex-test-"),
    });
    unsubscribe();
  });
  it("keeps activity stable on no-change polls and advances on provider activity", async () => {
    expect(adapter.activityAt(threadId)).toBeNull();
    thread.updatedAt = 1;
    await adapter.resumeThread(threadId);
    const previous = adapter.activityAt(threadId);
    await adapter.readThread(threadId);
    expect(adapter.activityAt(threadId)).toBe(previous);
    fake.broadcast({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item-1", delta: "hello" },
    });
    await vi.waitFor(() =>
      expect(adapter.activityAt(threadId)).not.toBe(previous),
    );
  });
  it("checks resumability on a fresh read-only connection: notLoaded exists, gone does not", async () => {
    thread.status = { type: "notLoaded" };
    expect(await adapter.checkResumable(threadId)).toBe(true);
    expect(fake.connections).toBe(2);
    expect(adapter.generation()).toBe(1);
    fake.handle(() => ({ error: traffic.missing }));
    expect(await adapter.checkResumable("gone" as ProviderSessionId)).toBe(
      false,
    );
    // Known to Codex's state database but its rollout file is gone: metadata reads fine, resume fails.
    fake.handle((method) =>
      method === "thread/resume"
        ? {
            error: {
              code: -32600,
              message: `failed to resolve rollout path \`/x/rollout-${threadId}.jsonl\`: file does not exist`,
            },
          }
        : { result: { thread } },
    );
    expect(await adapter.checkResumable(threadId)).toBe(false);
    fake.handle(() => ({
      error: { code: -32600, message: "permission denied" },
    }));
    expect(await adapter.checkResumable(threadId)).toBeNull();
  });
  it("disconnects to unknown and clears stale requests without replaying a lost RPC", async () => {
    replayApproval = true;
    await adapter.resumeThread(threadId);
    fake.handle((_method, _params, socket) => {
      socket.terminate();
      return undefined;
    });
    await expect(adapter.interruptTurn({ threadId, turnId })).rejects.toThrow(
      "closed",
    );
    expect(adapter.generation()).toBeNull();
    expect(await adapter.checkResumable(threadId)).toBeNull();
    expect(
      fake.messages.filter(
        (entry) =>
          (entry.message as { method?: string }).method === "turn/interrupt",
      ),
    ).toHaveLength(1);
  });
  it("rejects malformed messages, incomplete histories, and wrong-thread responses", async () => {
    thread.turns[0].itemsView = "summary";
    await expect(adapter.resumeThread(threadId)).rejects.toThrow(
      "Invalid Codex response",
    );
    thread.turns[0].itemsView = "full";
    thread.id = "different-thread";
    await expect(adapter.resumeThread(threadId)).rejects.toThrow(
      "different thread",
    );
    fake.broadcast({ id: "oops" });
    await vi.waitFor(() => expect(adapter.generation()).toBeNull());
  });
  it("keeps a nonblocking user question and encodes explicit answers", async () => {
    await adapter.resumeThread(threadId);
    fake.broadcast({
      id: "question",
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: "question-1",
        isBlocking: false,
        autoResolutionMs: null,
        questions: [{ id: "label", question: "Which label?" }],
      },
    });
    await vi.waitFor(async () =>
      expect(
        (await adapter.readThread(threadId)).pendingRequests,
      ).toMatchObject([{ kind: "question", isBlocking: false }]),
    );
    await expect(
      adapter.answerRequest({ ...answer(1), requestId: "question" }),
    ).rejects.toThrow("Missing");
    await adapter.answerRequest({
      ...answer(1),
      requestId: "question",
      answers: { label: ["Beta"] },
    });
    await vi.waitFor(() =>
      expect(fake.messages.map((entry) => entry.message)).toContainEqual({
        id: "question",
        result: { answers: { label: { answers: ["Beta"] } } },
      }),
    );
  });
  it("does not carry a retrying error into a completed turn", async () => {
    await adapter.resumeThread(threadId);
    fake.broadcast({
      method: "error",
      params: {
        threadId,
        turnId,
        error: { message: "retrying", codexErrorInfo: "serverOverloaded" },
        willRetry: true,
      },
    });
    await vi.waitFor(async () =>
      expect((await adapter.readThread(threadId)).lastError).toMatchObject({
        willRetry: true,
        kind: "serverOverloaded",
      }),
    );
    thread.status = { type: "idle" };
    thread.turns[0].status = "completed";
    expect((await adapter.readThread(threadId)).lastError).toBeNull();
  });
});

const recorded = JSON.parse(
  await readFile(
    new URL("./fixtures/recorded-0.154.0.json", import.meta.url),
    "utf8",
  ),
);
it("accepts the recorded emittedAtMs envelope and preserves provider timestamps on repeated events", async () => {
  await adapter.resumeThread(threadId);
  const hints: Hint[] = [];
  adapter.subscribe((hint) => hints.push(hint));
  fake.broadcast(recorded.notification);
  await vi.waitFor(() => expect(hints).toHaveLength(1));
  expect(adapter.generation()).toBe(1);
  thread.updatedAt = 1;
  const second = createCodexAdapter({ taskDirectory: fake.directory });
  try {
    await second.reconnect();
    await second.resumeThread(threadId);
    fake.broadcast({
      method: "item/agentMessage/delta",
      params: { threadId, delta: "same recorded event" },
      emittedAtMs: recorded.notification.emittedAtMs,
    });
    await vi.waitFor(() =>
      expect(second.activityAt(threadId)).toBe(
        new Date(recorded.notification.emittedAtMs).toISOString(),
      ),
    );
    fake.broadcast({
      method: "item/agentMessage/delta",
      params: { threadId, delta: "same recorded event" },
      emittedAtMs: recorded.notification.emittedAtMs,
    });
    expect((await second.readThread(threadId)).status).toBe("active");
    expect(second.activityAt(threadId)).toBe(
      new Date(recorded.notification.emittedAtMs).toISOString(),
    );
  } finally {
    await second.stopServer();
  }
});
it("distinguishes recorded not-loaded errors from confirmed missing history through native resume", async () => {
  const missingId = "00000000-0000-7000-8000-000000000000" as ProviderSessionId;
  let hasHistory = true;
  fake.handle((method) =>
    method === "thread/read"
      ? { error: recorded.unloaded }
      : hasHistory
        ? { result: { thread: { ...recorded.metadata, id: missingId } } }
        : { error: recorded.missing },
  );
  expect(await adapter.checkResumable(missingId)).toBe(true);
  hasHistory = false;
  expect(await adapter.checkResumable(missingId)).toBe(false);
  expect(adapter.generation()).toBe(1);
});
it("rejects wrong-thread approvals and limits permission grants to the requested scope", async () => {
  await adapter.resumeThread(threadId);
  const permissions = {
    network: { enabled: true },
    fileSystem: {
      read: null,
      write: null,
      entries: [
        { path: { type: "path", path: "/tmp/fixture" }, access: "write" },
      ],
    },
  };
  fake.broadcast({
    id: 0,
    method: "item/permissions/requestApproval",
    params: { threadId, turnId, itemId: "permission-1", permissions },
  });
  await vi.waitFor(async () =>
    expect((await adapter.readThread(threadId)).pendingRequests).toHaveLength(
      1,
    ),
  );
  await expect(
    adapter.answerRequest({
      ...answer(1),
      threadId: "other" as ProviderSessionId,
    }),
  ).rejects.toThrow("No matching");
  await adapter.answerRequest(answer(1));
  await vi.waitFor(() =>
    expect(fake.messages.map((entry) => entry.message)).toContainEqual({
      id: 0,
      result: { scope: "turn", permissions },
    }),
  );
});
it("encodes file-change declines and removes approvals resolved by another subscriber", async () => {
  await adapter.resumeThread(threadId);
  fake.broadcast({
    id: 0,
    method: "item/fileChange/requestApproval",
    params: { threadId, turnId, itemId: "file-1" },
  });
  await vi.waitFor(async () =>
    expect((await adapter.readThread(threadId)).pendingRequests).toMatchObject([
      { kind: "file_approval" },
    ]),
  );
  await adapter.answerRequest({ ...answer(1), decision: "decline" });
  await vi.waitFor(() =>
    expect(fake.messages.map((entry) => entry.message)).toContainEqual({
      id: 0,
      result: { decision: "decline" },
    }),
  );
  fake.broadcast({
    method: "serverRequest/resolved",
    params: { threadId, requestId: 0 },
  });
  await vi.waitFor(async () =>
    expect((await adapter.readThread(threadId)).pendingRequests).toHaveLength(
      0,
    ),
  );
});
it("does not silently accept malformed user-message content or a mismatched steer result", async () => {
  thread.turns[0].items[0].content = [{ type: "text", text: 42 }];
  await expect(adapter.resumeThread(threadId)).rejects.toThrow(
    "Invalid Codex response",
  );
  fake.handle(() => ({ result: { turnId: "another-turn" } }));
  await expect(
    adapter.steerTurn({ threadId, expectedTurnId: turnId, text: "hello" }),
  ).rejects.toThrow("different turn ID");
});
it("times out a lost response without resending and starts above a persisted generation", async () => {
  const second = createCodexAdapter({
    taskDirectory: fake.directory,
    timeoutMs: 30,
    initialGeneration: 100,
  });
  try {
    await second.reconnect();
    expect(second.generation()).toBe(101);
    fake.handle(() => undefined);
    await expect(second.startTurn({ threadId, text: "once" })).rejects.toThrow(
      "delivery is unknown",
    );
    expect(
      fake.messages.filter(
        (entry) =>
          (entry.message as { method?: string }).method === "turn/start",
      ),
    ).toHaveLength(1);
  } finally {
    await second.stopServer();
  }
});

it("reads a loaded thread that has had no turn as idle, and rethrows other read errors", async () => {
  await adapter.startThread({
    cwd: fake.directory as WorktreePath,
    model: "gpt-5.6-luna",
    sandbox: "read-only",
    developerInstructions: "",
    config: {},
  });
  // Codex 0.154 refuses `thread/read` on a thread `thread/start` created until its first user
  // message. Such a thread is idle with no turns; reading it as unknown would stop the send
  // gate from ever sending that first message (the first real reviewer run).
  readError = `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`;
  const fresh = await adapter.readThread(threadId);
  expect(fresh.status).toBe("idle");
  expect(fresh.turns).toEqual([]);
  expect(fresh.pendingRequests).toEqual([]);
  readError = "thread not loaded: something else";
  await expect(adapter.readThread(threadId)).rejects.toThrow("not loaded");
});
