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

function leadDeps(
  readConversation: () => Promise<ConversationRead>,
  options: {
    status?: "idle" | "working" | "waiting";
    pendingDialog?: object | null;
  } = {},
) {
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
          pendingDialog: options.pendingDialog ?? null,
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
        state: vi.fn(async () => ({ status: options.status ?? "idle" })),
        confirmMessages: vi.fn(async () => {}),
      }) as never,
    now: () => now,
    after: () => () => {},
    replace: (owner: string, rows: never[]) => {
      const changes = published.replace(owner, null, rows);
      if (changes.length) patches(changes);
    },
    log: vi.fn(),
  };
  return { deps, patches, published };
}

test("Main exposes a hook dialog only when its authoritative status is waiting", async () => {
  const dialog = {
    kind: "permission",
    tool: "Bash",
    at: now,
  };
  for (const [status, expected] of [
    ["working", null],
    [
      "waiting",
      expect.objectContaining({ source: "claude_dialog", tool: "Bash" }),
    ],
  ] as const) {
    const { deps, published } = leadDeps(
      vi.fn(async () => ({ items: [], truncated: false })),
      { status, pendingDialog: dialog },
    );
    const views = new ConversationViews(deps);
    views.subscriptions([leadScope]);
    views.ensure([leadScope]);
    await vi.waitFor(() =>
      expect(
        published.rows().find((row) => row.collection === "conversation"),
      ).toBeDefined(),
    );
    expect(
      published.rows().find((row) => row.collection === "conversation")?.value,
    ).toMatchObject({ pendingPrompt: expected });
    await views.stop();
  }
});

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
    replace,
    log: vi.fn(),
  });
  views.subscriptions([scope]);
  views.ensure([scope]);
  await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  expect(codexIfRunning).toHaveBeenCalledWith("task-1");
  expect(replace.mock.calls[0]?.[1][0].value).toMatchObject({
    provider: "codex",
    status: "idle",
    error: expect.stringMatching(/\S/),
  });
  await views.stop();
});

test("run delivery attention publishes as failed until provider delivery", async () => {
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
  const messages = [
    {
      id: "message-failed",
      runId: "run-1",
      taskId: "task-1",
      purpose: "human",
      text: "Did this land?",
      status: "sent",
      attempts: 1,
      deliveryAttention: true,
      deliveryReason: "not confirmed by the provider",
      sentAt: now,
      pendingSince: null,
      when: "now",
    },
    {
      id: "message-delivered",
      runId: "run-1",
      taskId: "task-1",
      purpose: "human",
      text: "This landed later",
      status: "delivered",
      attempts: 1,
      deliveryAttention: true,
      deliveryReason: "not confirmed by the provider",
      sentAt: now,
      pendingSince: null,
      when: "now",
    },
  ];
  const replace = vi.fn();
  const scope = {
    kind: "conversation",
    target: { kind: "run", runId: "run-1" },
  } as Subscription;
  const views = new ConversationViews({
    store: {
      tasks: vi.fn(() => [{ id: "task-1" }]),
      runs: vi.fn(() => [run]),
      messages: vi.fn(() => messages),
    } as never,
    adapters: {
      codexIfRunning: vi.fn(() => ({
        readConversation: vi.fn(async () => ({ items: [], truncated: false })),
      })),
    } as never,
    lead: vi.fn() as never,
    now: () => now,
    after: () => () => {},
    replace,
    log: vi.fn(),
  });
  views.subscriptions([scope]);
  views.ensure([scope]);
  await vi.waitFor(() => expect(replace).toHaveBeenCalled());
  expect(replace.mock.calls[0]?.[1][0].value.sends).toEqual([
    expect.objectContaining({
      id: "message-failed",
      state: "failed",
      reason: "not confirmed by the provider",
    }),
    expect.objectContaining({ id: "message-delivered", state: "delivered" }),
  ]);
  await views.stop();
});

test("an in-flight read cannot republish or cache rows after the last viewer leaves", async () => {
  let finishRead: (value: ConversationRead) => void = () => {};
  const item = (id: string) => ({
    id,
    role: "assistant" as const,
    kind: "text" as const,
    text: id,
    clipped: false,
    tool: null,
    at: now,
  });
  const readConversation = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<ConversationRead>((resolve) => {
          finishRead = resolve;
        }),
    )
    .mockResolvedValue({ items: [item("fresh")], truncated: false });
  const { deps, published } = leadDeps(readConversation);
  const views = new ConversationViews(deps);
  views.subscriptions([leadScope]);
  views.ensure([leadScope]);
  await vi.waitFor(() => expect(readConversation).toHaveBeenCalled());
  views.subscriptions([]);
  finishRead({ items: [item("stale")], truncated: false });
  // Let the resolved read finish publishing before inspecting the subscriber-visible rows.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(published.rows()).toEqual([]);

  views.subscriptions([leadScope]);
  views.ensure([leadScope]);
  await vi.waitFor(() =>
    expect(published.rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: "conversation_item",
          value: expect.objectContaining({ id: "fresh" }),
        }),
      ]),
    ),
  );
  expect(
    published.rows().filter((row) => row.collection === "conversation_item"),
  ).toHaveLength(1);
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
        confirmMessages: vi.fn(async () => {}),
      }) as never,
    now: () => "2026-09-14T01:00:00.000Z" as never,
    after: () => () => {},
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
