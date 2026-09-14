import type { ConversationRead } from "@loom/core";
import type { Subscription } from "@loom/protocol";
import { expect, test, vi } from "vitest";
import { ConversationViews } from "./conversations.js";
import { PublishedRows } from "./views.js";

const now = "2026-09-14T01:00:00.000Z" as never;
const leadScope = {
  kind: "conversation",
  target: { kind: "lead", repoId: "repo-1" },
} as Subscription;

function leadDeps(readConversation: () => Promise<ConversationRead>) {
  const published = new PublishedRows();
  const patches = vi.fn();
  const deps = {
    store: {
      leadMessages: { list: vi.fn(() => []), update: vi.fn() },
    } as never,
    adapters: {
      claude: {
        hookSummary: vi.fn(async () => ({
          transcriptPath: null,
          pendingDialog: null,
          promptSubmits: [],
        })),
        promptReceipt: vi.fn(async () => null),
        readConversation,
      },
    } as never,
    lead: () =>
      ({
        sessionId: "session-1",
        cwd: "/repo",
        state: vi.fn(async () => ({ status: "idle" })),
      }) as never,
    now: () => now,
    after: () => () => {},
    deliveryTimeoutMs: 1_000,
    replace: (owner: string, rows: never[]) => {
      const changes = published.replace(owner, null, rows);
      if (changes.length) patches(changes);
    },
    log: vi.fn(),
  };
  return { deps, patches, published };
}

test("subscription publishes initial rows and a hint publishes only the appended item", async () => {
  const items = [
    {
      id: "message-1",
      role: "assistant" as const,
      kind: "text" as const,
      text: "First",
      clipped: false,
      tool: null,
      at: now,
    },
  ];
  const readConversation = vi.fn(async () => ({
    items: structuredClone(items),
    truncated: false,
  }));
  const { deps, patches } = leadDeps(readConversation);
  const views = new ConversationViews(deps);
  views.subscriptions([leadScope]);
  views.ensure([leadScope]);
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(1));
  expect(patches.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ collection: "conversation", op: "upsert" }),
      expect.objectContaining({
        collection: "conversation_item",
        op: "upsert",
        value: expect.objectContaining({ id: "message-1" }),
      }),
    ]),
  );

  patches.mockClear();
  items.push({
    id: "message-2",
    role: "assistant",
    kind: "text",
    text: "Second",
    clipped: false,
    tool: null,
    at: now,
  });
  views.hint("session-1");
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(1));
  expect(patches.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      collection: "conversation_item",
      op: "upsert",
      value: expect.objectContaining({ id: "message-2" }),
    }),
  ]);
  await views.stop();
});

test("a stopped Main publishes stopped without reading or launching", async () => {
  const readConversation = vi.fn();
  const replace = vi.fn();
  const views = new ConversationViews({
    store: {
      leadMessages: { list: vi.fn(() => []), update: vi.fn() },
    } as never,
    adapters: { claude: { readConversation } } as never,
    lead: () =>
      ({
        sessionId: null,
        cwd: null,
        state: vi.fn(async () => ({ status: "stopped" })),
        open: vi.fn(),
      }) as never,
    now: () => now,
    after: () => () => {},
    deliveryTimeoutMs: 1_000,
    replace,
    log: vi.fn(),
  });
  views.subscriptions([leadScope]);
  views.ensure([leadScope]);
  await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  expect(replace.mock.calls[0]?.[1][0].value).toMatchObject({
    status: "stopped",
    error: null,
  });
  expect(readConversation).not.toHaveBeenCalled();
  await views.stop();
});

test("an unloaded Codex thread reports an error without starting a server", async () => {
  const run = {
    id: "run-1",
    taskId: "task-1",
    origin: "loom",
    provider: "codex",
    sessionId: "thread-1",
    status: "idle",
    endedAt: null,
    pendingRequests: [],
  } as never;
  const codexIfRunning = vi.fn(() => null);
  const replace = vi.fn();
  const scope = {
    kind: "conversation",
    target: { kind: "run", runId: "run-1" },
  } as Subscription;
  const views = new ConversationViews({
    store: {
      tasks: vi.fn(() => [{ id: "task-1" }]),
      runs: vi.fn(() => [run]),
      messages: vi.fn(() => []),
      leadMessages: { list: vi.fn(() => []), update: vi.fn() },
    } as never,
    adapters: { codexIfRunning } as never,
    lead: vi.fn() as never,
    now: () => now,
    after: () => () => {},
    deliveryTimeoutMs: 1_000,
    replace,
    log: vi.fn(),
  });
  views.subscriptions([scope]);
  views.ensure([scope]);
  await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  expect(codexIfRunning).toHaveBeenCalledWith("task-1");
  expect(replace.mock.calls[0]?.[1][0].value.error).toBe(
    "Codex thread is not loaded; open the terminal",
  );
  await views.stop();
});

test("an in-flight read cannot republish or cache rows after the last viewer leaves", async () => {
  let finishRead: (value: ConversationRead) => void = () => {};
  const readConversation = vi.fn(
    () =>
      new Promise<ConversationRead>((resolve) => {
        finishRead = resolve;
      }),
  );
  const replace = vi.fn();
  const log = vi.fn();
  const scope = {
    kind: "conversation",
    target: { kind: "lead", repoId: "repo-1" },
  } as Subscription;
  const views = new ConversationViews({
    store: {
      leadMessages: { list: vi.fn(() => []), update: vi.fn() },
    } as never,
    adapters: {
      claude: {
        hookSummary: vi.fn(async () => ({
          transcriptPath: null,
          pendingDialog: null,
          promptSubmits: [],
        })),
        readConversation,
      },
    } as never,
    lead: () =>
      ({
        sessionId: "session-1",
        cwd: "/repo",
        state: vi.fn(async () => ({ status: "idle" })),
      }) as never,
    now: () => "2026-09-14T01:00:00.000Z" as never,
    after: () => () => {},
    deliveryTimeoutMs: 1_000,
    replace,
    log,
  });

  views.subscriptions([scope]);
  views.ensure([scope]);
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalledTimes(1));
  views.subscriptions([]);
  finishRead({ items: [], truncated: false });
  await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenLastCalledWith("conversation:lead:repo-1", []);

  views.subscriptions([scope]);
  views.ensure([scope]);
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalledTimes(2));
  await views.stop();
});

test("a hint during a read schedules one follow-up read", async () => {
  let finishRead: (value: ConversationRead) => void = () => {};
  const readConversation = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<ConversationRead>((resolve) => {
          finishRead = resolve;
        }),
    )
    .mockResolvedValue({ items: [], truncated: false });
  const views = new ConversationViews({
    store: {
      leadMessages: { list: vi.fn(() => []), update: vi.fn() },
    } as never,
    adapters: {
      claude: {
        hookSummary: vi.fn(async () => ({
          transcriptPath: null,
          pendingDialog: null,
          promptSubmits: [],
        })),
        readConversation,
      },
    } as never,
    lead: () =>
      ({
        sessionId: "session-1",
        cwd: "/repo",
        state: vi.fn(async () => ({ status: "idle" })),
      }) as never,
    now: () => "2026-09-14T01:00:00.000Z" as never,
    after: () => () => {},
    deliveryTimeoutMs: 1_000,
    replace: vi.fn(),
    log: () => {},
  });
  const scope = {
    kind: "conversation",
    target: { kind: "lead", repoId: "repo-1" },
  } as Subscription;

  views.subscriptions([scope]);
  views.ensure([scope]);
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalledTimes(1));
  views.hint("session-1");
  views.hint("session-1");
  finishRead({ items: [], truncated: false });
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalledTimes(2));
  await views.stop();
});
