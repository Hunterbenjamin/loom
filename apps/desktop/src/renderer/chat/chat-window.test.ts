// @vitest-environment happy-dom
import {
  type AckOutcome,
  type Conversation,
  type ConversationItem,
  stateFromSnapshot,
} from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  at,
  id,
  meta,
  snapshot,
} from "../../../../../packages/protocol/src/test-support.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { ChatWindow, unmatchedSends } from "./chat-window.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.clearAllMocks();
});

const repoId = id.repo("repo-loom");
const readAt = at("2026-09-14T01:00:00.000Z");
const header = (patch: Partial<Conversation> = {}): Conversation => ({
  target: { kind: "lead", repoId },
  provider: "claude",
  status: "idle",
  pendingPrompt: null,
  sends: [],
  truncated: false,
  readAt,
  error: null,
  ...patch,
});
const item = (patch: Partial<ConversationItem> = {}): ConversationItem => ({
  conversationKey: `lead:${repoId}`,
  order: 0,
  id: "item-1",
  role: "user",
  kind: "text",
  text: "hello",
  clipped: false,
  tool: null,
  at: readAt,
  ...patch,
});

function mount(conversation: Conversation, items: ConversationItem[] = []) {
  const body = {
    ...snapshot(),
    conversations: [conversation],
    conversationItems: items,
  };
  const store = createStore(undefined, true, "test");
  store.applyProtocol(stateFromSnapshot(meta, body));
  store.openChat(conversation.target);
  const send = vi.fn(
    async (): Promise<AckOutcome> => ({
      ok: true as const,
      result: {
        kind: "lead_message" as const,
        id: "message-1",
        state: "sent" as const,
      },
    }),
  );
  store.setSender(send);
  window.loomHost = {
    ...window.loomHost,
    setMode: vi.fn(),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires typed children.
        children: createElement(ChatWindow),
      }),
    ),
  );
  return { host, send, store };
}

function enter(input: HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error("composer missing");
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("a delivered send disappears after its matching transcript item", () => {
  const sends = [
    {
      id: "send-1",
      text: "hello",
      state: "delivered" as const,
      at: readAt,
      reason: null,
    },
    {
      id: "send-2",
      text: "still pending",
      state: "sent" as const,
      at: readAt,
      reason: "not confirmed by Claude",
    },
  ];
  expect(unmatchedSends(sends, [item()])).toEqual([sends[1]]);
});

test("scrolling away from the bottom offers an explicit jump", async () => {
  const { host } = mount(header(), [item()]);
  const scroller = host.querySelector<HTMLDivElement>(".chat-conversation");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, value: 100 },
  });
  await act(async () => scroller?.dispatchEvent(new Event("scroll")));
  expect(host.querySelector(".chat-jump-latest")?.textContent).toBe(
    "Jump to latest",
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".chat-jump-latest")?.click(),
  );
  expect(host.querySelector(".chat-jump-latest")).toBeNull();
});

test("lead send, prefix rejection, delivery state and prompt answer are wired", async () => {
  const conversation = header({
    pendingPrompt: {
      source: "claude_dialog",
      kind: "permission",
      tool: "Read",
      requestId: "dialog-1",
      at: readAt,
    },
    sends: [
      {
        id: "send-visible",
        text: "waiting",
        state: "delivered",
        at: readAt,
        reason: null,
      },
    ],
  });
  const { host, send } = mount(conversation);
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => enter(input, "/help"));
  expect(host.querySelector(".chat-error")?.textContent).toContain(
    "not allowed",
  );
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
      ?.disabled,
  ).toBe(true);
  expect(send).not.toHaveBeenCalled();

  await act(async () => enter(input, "ship it"));
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Send message"]')
      ?.click(),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "send_lead_message",
      repoId,
      text: "ship it",
      clientMessageId: expect.any(String),
    }),
  );
  expect(host.querySelector(".chat-send")?.textContent).toContain("delivered");

  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>(".chat-prompt button")]
      .find((button) => button.textContent === "Yes")
      ?.click(),
  );
  expect(send).toHaveBeenLastCalledWith({
    kind: "answer_lead_prompt",
    repoId,
    choice: 1,
    expectedDialog: { requestId: "dialog-1", at: readAt },
  });
});

test("a run conversation sends through the existing human command", async () => {
  const body = snapshot();
  const run = body.runs[0];
  if (!run) throw new Error("fixture run missing");
  const conversation = header({
    target: { kind: "run", runId: run.id },
    provider: run.provider,
  });
  const { host, send, store } = mount(conversation);
  store.setSender(
    send.mockResolvedValue({
      ok: true,
      result: { kind: "human", inputId: id.input("input-chat") },
    }),
  );
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => enter(input, "continue"));
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Send message"]')
      ?.click(),
  );
  expect(send).toHaveBeenCalledWith({
    kind: "human",
    taskId: run.taskId,
    command: {
      type: "send_message",
      runId: run.id,
      text: "continue",
      expectedRun: {
        sessionEpoch: run.sessionEpoch,
        attempts: run.attempts,
      },
    },
  });
});
