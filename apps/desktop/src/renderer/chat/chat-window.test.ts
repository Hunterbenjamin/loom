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
import {
  CHAT_COMPOSER_LINE_HEIGHT,
  CHAT_COMPOSER_MAX_HEIGHT,
  ChatWindow,
  chatTimeline,
  resizeChatComposer,
} from "./chat-window.js";

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
  const store = createStore(undefined, "test");
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

test("a transcript match replaces its send while an unmatched send stays in place", () => {
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
  expect(chatTimeline(sends, [item()])).toEqual([
    { kind: "item", item: item() },
    { kind: "send", send: sends[1] },
  ]);
});

test("an old send whose transcript copy scrolled out does not steal a later identical message", () => {
  const send = (
    id: string,
    text: string,
    time: string,
  ): Conversation["sends"][number] => ({
    id,
    text,
    state: "delivered",
    at: at(time),
    reason: null,
    when: "now",
  });
  // The transcript starts at 02:00; the 01:30 "Okay" belongs to history that isn't loaded.
  const question = item({
    id: "question",
    text: "What about the backlog?",
    at: at("2026-09-14T02:10:00.400Z"),
    order: 1,
  });
  const okay = item({
    id: "okay",
    text: "Okay",
    at: at("2026-09-14T02:20:00.400Z"),
    order: 2,
  });
  const reply = item({
    id: "reply",
    role: "assistant",
    text: "Sure",
    at: at("2026-09-14T02:00:00.000Z"),
    order: 0,
  });
  const sends = [
    send("old-okay", "Okay", "2026-09-14T01:30:00.000Z"),
    send("question", "What about the backlog?", "2026-09-14T02:10:00.000Z"),
    send("okay", "Okay", "2026-09-14T02:20:00.000Z"),
  ];
  expect(chatTimeline(sends, [reply, question, okay])).toEqual([
    { kind: "item", item: reply },
    { kind: "item", item: question },
    { kind: "item", item: okay },
  ]);
});

test("untimestamped sends stay before the next matching transcript turn", () => {
  const first = item({ id: "first", at: null, text: "first", order: 0 });
  const second = item({ id: "second", at: null, text: "second", order: 1 });
  const sends: Conversation["sends"] = [
    {
      id: "one",
      text: "first",
      state: "delivered",
      at: readAt,
      reason: null,
      when: "now",
    },
    {
      id: "refused",
      text: "between",
      state: "refused",
      at: readAt,
      reason: "no",
      when: "now",
    },
    {
      id: "two",
      text: "second",
      state: "sent",
      at: readAt,
      reason: null,
      when: "now",
    },
  ];
  expect(chatTimeline(sends, [first, second])).toEqual([
    { kind: "item", item: first },
    { kind: "send", send: sends[1] },
    { kind: "item", item: second },
  ]);
});

test("scrolling away from the bottom offers an explicit jump", async () => {
  const { host } = mount(header(), [item()]);
  const scroller = host.querySelector<HTMLDivElement>(".chat-conversation");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  await act(async () => scroller?.dispatchEvent(new Event("scroll")));
  expect(host.querySelector(".chat-jump-latest")?.textContent).toBe(
    "Jump to latest",
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".chat-jump-latest")?.click(),
  );
  expect(host.querySelector(".chat-jump-latest")).toBeNull();
  expect(scroller?.scrollTop).toBe(800);
});

test("the chat follows output that grows an existing item, and stops following once scrolled away", async () => {
  const conversation = header();
  const { host, store } = mount(conversation, [item()]);
  const scroller = host.querySelector<HTMLDivElement>(".chat-conversation");
  let scrollHeight = 800;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 500 },
  });
  const stream = (text: string) =>
    act(async () =>
      store.applyProtocol(
        stateFromSnapshot(meta, {
          ...snapshot(),
          conversations: [conversation],
          conversationItems: [item({ role: "assistant", text })],
        }),
      ),
    );
  scrollHeight = 1200;
  await stream("streaming more text");
  expect(scroller?.scrollTop).toBe(1200);

  if (scroller) scroller.scrollTop = 200;
  await act(async () => scroller?.dispatchEvent(new Event("scroll")));
  scrollHeight = 1600;
  await stream("streaming even more text");
  expect(scroller?.scrollTop).toBe(200);
});

test("opening the chat focuses the composer", async () => {
  const { host, store } = mount(header());
  store.setChatView("minimized");
  await act(async () => store.setChatView("open"));
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      host.querySelector<HTMLTextAreaElement>("textarea"),
    ),
  );
});

test("during a turn new messages queue by default and a queued message can steer", async () => {
  const { host, send } = mount(
    header({
      status: "working",
      sends: [
        {
          id: "queued-1",
          text: "use the other branch",
          state: "queued",
          at: readAt,
          reason: null,
          when: "after_turn",
        },
      ],
    }),
  );
  // The composer has no steer or send-after-turn choice: Enter queues for after this turn.
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons().some((b) => b.textContent === "Send after turn")).toBe(
    false,
  );
  expect(
    host.querySelector(".chat-composer")?.textContent?.includes("Steer"),
  ).toBe(false);
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => enter(input, "hold this"));
  await act(async () =>
    input?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "send_lead_message", when: "after_turn" }),
  );
  // The queued message sits in the conversation with its own Steer button.
  const queued = host.querySelector(".chat-send.waiting");
  expect(queued?.textContent).toContain("use the other branch");
  await act(async () =>
    [...(queued?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((b) => b.textContent === "Steer now")
      ?.click(),
  );
  expect(send).toHaveBeenLastCalledWith({
    kind: "steer_lead_message",
    repoId,
    clientMessageId: "queued-1",
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Stop turn"]')?.click(),
  );
  expect(send).toHaveBeenLastCalledWith({ kind: "interrupt_lead", repoId });
});

test("the voice button sits with the send button on the right", () => {
  window.loomHost = {
    ...window.loomHost,
    platform: "darwin",
  } as typeof window.loomHost;
  const { host } = mount(header());
  const right = host.querySelector(".chat-send-actions");
  expect(right?.querySelector('[aria-label="Dictate message"]')).not.toBeNull();
  expect(right?.querySelector('[aria-label="Send message"]')).not.toBeNull();
});

test("the composer grows, caps at four lines, and shrinks after send", async () => {
  const { host } = mount(header());
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) throw new Error("composer missing");
  let scrollHeight = 64;
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });

  resizeChatComposer(input);
  expect(input.style.height).toBe("64px");
  expect(input.style.overflowY).toBe("hidden");

  scrollHeight = CHAT_COMPOSER_MAX_HEIGHT + 40;
  resizeChatComposer(input);
  expect(input.style.height).toBe(`${CHAT_COMPOSER_MAX_HEIGHT}px`);
  expect(input.style.overflowY).toBe("auto");
  expect(CHAT_COMPOSER_MAX_HEIGHT).toBeGreaterThanOrEqual(
    CHAT_COMPOSER_LINE_HEIGHT * 4,
  );

  await act(async () => enter(input, "one\ntwo\nthree\nfour\nfive"));
  expect(input.style.height).toBe(`${CHAT_COMPOSER_MAX_HEIGHT}px`);
  scrollHeight = 24;
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Send message"]')
      ?.click(),
  );
  expect(input.value).toBe("");
  expect(input.style.height).toBe("24px");
  expect(input.style.overflowY).toBe("hidden");
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
      when: "now",
      attachmentIds: [],
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

test("a failed send renders its state and delivery reason", () => {
  const { host } = mount(
    header({
      sends: [
        {
          id: "send-failed",
          text: "Please continue",
          state: "failed",
          at: readAt,
          reason: "not confirmed by the provider",
        },
      ],
    }),
  );
  const failed = host.querySelector(".chat-send.failed");
  expect(failed?.textContent).toContain("failed");
  expect(failed?.textContent).toContain("not confirmed by the provider");
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
      when: "now",
      attachmentIds: [],
      expectedRun: {
        sessionEpoch: run.sessionEpoch,
        attempts: run.attempts,
      },
    },
  });
});

test("composer page keys scroll the conversation and Cmd+Down restores following", async () => {
  const conversation = header();
  const { host, store } = mount(conversation, [item()]);
  const scroller = host.querySelector<HTMLDivElement>(".chat-conversation");
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!scroller || !input) throw new Error("Chat missing");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 600 },
  });
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      input.dispatchEvent(event);
      // happy-dom doesn't emit the browser's scroll event on scrollTop assignment.
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(event.defaultPrevented).toBe(true);
  };
  await act(async () => enter(input, "draft"));
  scroller.scrollTop = 600;
  input.setSelectionRange(2, 2);
  await press("PageUp", { shiftKey: true });
  expect(scroller.scrollTop).toBe(300);
  expect(input.selectionStart).toBe(2);
  expect(host.querySelector(".chat-jump-latest")).not.toBeNull();
  const stream = (text: string) =>
    act(async () =>
      store.applyProtocol(
        stateFromSnapshot(meta, {
          ...snapshot(),
          conversations: [conversation],
          conversationItems: [item({ role: "assistant", text })],
        }),
      ),
    );
  await stream("new output");
  expect(scroller.scrollTop).toBe(300);
  await press("PageDown", { shiftKey: true });
  expect(scroller.scrollTop).toBe(600);
  await press("ArrowUp", { metaKey: true });
  expect(scroller.scrollTop).toBe(300);
  await press("ArrowDown", { metaKey: true });
  expect(scroller.scrollTop).toBe(1000);
  expect(host.querySelector(".chat-jump-latest")).toBeNull();
  scroller.scrollTop = 600;
  await stream("more output");
  expect(scroller.scrollTop).toBe(1000);
});

test("reading keys navigate, typing preserves the draft and bare PageUp stays native", async () => {
  const { host } = mount(header(), [item()]);
  const transcript = host.querySelector<HTMLDivElement>(".chat-conversation")!;
  const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 500 },
  });
  await act(async () => enter(input, "draft"));
  input.setSelectionRange(2, 2);
  transcript.scrollTop = 500;
  await act(async () => transcript.dispatchEvent(new Event("scroll")));
  expect(document.activeElement).toBe(transcript);
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () =>
      transcript.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      ),
    );
  };
  await press("j");
  expect(transcript.scrollTop).toBe(520);
  await press("k");
  expect(transcript.scrollTop).toBe(500);
  await press("d", { ctrlKey: true });
  expect(transcript.scrollTop).toBe(650);
  await press("u", { ctrlKey: true });
  await press(" ");
  expect(transcript.scrollTop).toBe(800);
  await press(" ", { shiftKey: true });
  expect(transcript.scrollTop).toBe(500);
  await press("g");
  await press("g");
  expect(transcript.scrollTop).toBe(0);
  await press("q");
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("drqaft");
  expect(input.selectionStart).toBe(3);
  transcript.focus();
  await press("Escape");
  expect(document.activeElement).toBe(input);
  transcript.focus();
  await press("G", { shiftKey: true });
  expect(document.activeElement).toBe(input);
  const event = new KeyboardEvent("keydown", {
    key: "PageUp",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
});
