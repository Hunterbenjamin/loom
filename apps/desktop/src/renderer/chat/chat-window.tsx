import {
  type Conversation,
  type ConversationItem,
  conversationKey,
} from "@loom/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore, useStoreApi } from "../store/react.js";

function comparableText(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

export const CHAT_COMPOSER_MIN_HEIGHT = 24;
export const CHAT_COMPOSER_LINE_HEIGHT = 20;
export const CHAT_COMPOSER_MAX_HEIGHT = CHAT_COMPOSER_LINE_HEIGHT * 4 + 4;

export function resizeChatComposer(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const contentHeight = textarea.scrollHeight;
  textarea.style.height = `${Math.max(
    CHAT_COMPOSER_MIN_HEIGHT,
    Math.min(contentHeight, CHAT_COMPOSER_MAX_HEIGHT),
  )}px`;
  textarea.style.overflowY =
    contentHeight > CHAT_COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

export function unmatchedSends(
  sends: Conversation["sends"],
  items: ConversationItem[],
) {
  const userItems = items.filter(
    (item) => item.role === "user" && item.kind === "text",
  );
  return sends.filter((send) => {
    if (send.state !== "delivered") return true;
    const match = userItems.findIndex(
      (item) => comparableText(item.text) === comparableText(send.text),
    );
    if (match < 0) return true;
    userItems.splice(match, 1);
    return false;
  });
}

export function ChatWindow() {
  const store = useStoreApi();
  const target = useStore((s) => s.ui.chatTarget);
  const view = useStore((s) => s.ui.chatView);
  const state = useStore((s) => s);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const key = target ? conversationKey(target) : "";
  const header = state.conversations.find(
    (value) => conversationKey(value.target) === key,
  );
  const items = state.conversationItems
    .filter((value) => value.conversationKey === key)
    .sort((a, b) => a.order - b.order);
  const run =
    target?.kind === "run"
      ? state.snapshot.runs.find((value) => value.id === target.runId)
      : null;
  const task = run
    ? state.snapshot.tasks.find((value) => value.id === run.taskId)
    : null;
  const title =
    target?.kind === "lead"
      ? "Main"
      : run
        ? `${run.role[0]?.toUpperCase()}${run.role.slice(1)}`
        : "Agent";
  const prefixError = /^[!/]/.test(text.trimStart());
  const contentVersion = `${items.length}:${header?.sends.length ?? 0}`;
  useLayoutEffect(() => {
    if (composer.current) resizeChatComposer(composer.current);
  });
  useEffect(() => {
    void contentVersion;
    if (view !== "minimized" && following.current)
      end.current?.scrollIntoView({ block: "end" });
  }, [contentVersion, view]);
  useEffect(() => {
    void key;
    if (view === "minimized") return;
    following.current = true;
    setShowJump(false);
    end.current?.scrollIntoView({ block: "end" });
  }, [key, view]);
  useEffect(() => {
    const open = (event: Event) =>
      store.openChat((event as CustomEvent).detail);
    window.addEventListener("loom:open-chat", open);
    return () => window.removeEventListener("loom:open-chat", open);
  }, [store]);
  if (!target || view === "minimized") return null;
  const openTerminal = () => {
    void window.loomHost.setMode("workbench");
    window.dispatchEvent(
      new CustomEvent("loom:open-chat-terminal", { detail: target }),
    );
  };
  const send = async () => {
    const value = text.trim();
    if (!value || prefixError || sending) return;
    setSending(true);
    const outcome =
      target.kind === "lead"
        ? await store.command({
            kind: "send_lead_message",
            repoId: target.repoId,
            text: value,
            clientMessageId: crypto.randomUUID(),
          })
        : run && task
          ? await store.command({
              kind: "human",
              taskId: task.id,
              command: {
                type: "send_message",
                runId: run.id,
                text: value,
                expectedRun: {
                  sessionEpoch: run.sessionEpoch,
                  attempts: run.attempts,
                },
              },
            })
          : null;
    if (outcome?.ok) setText("");
    setSending(false);
  };
  const answer = (choice: number | "escape") => {
    const prompt = header?.pendingPrompt;
    if (!prompt) return;
    if (target.kind === "lead" && prompt.source === "claude_dialog")
      void store.command({
        kind: "answer_lead_prompt",
        repoId: target.repoId,
        choice,
        expectedDialog: { requestId: prompt.requestId, at: prompt.at },
      });
    else if (target.kind === "run" && run && prompt.source === "codex_request")
      void store.command({
        kind: "human",
        taskId: run.taskId,
        command: {
          type: "answer_provider_request",
          runId: run.id,
          requestId: prompt.requestId,
          generation: prompt.generation,
          decision: choice === "escape" ? "decline" : "accept",
          answers: null,
        },
      });
    else if (target.kind === "run" && run && prompt.source === "claude_dialog")
      void store.command({
        kind: "human",
        taskId: run.taskId,
        command: {
          type: "answer_pane_prompt",
          runId: run.id,
          choice,
          expectedDialog:
            prompt.requestId && prompt.sessionEpoch !== undefined
              ? {
                  requestId: prompt.requestId,
                  at: prompt.at,
                  ...(prompt.command === undefined
                    ? {}
                    : { command: prompt.command }),
                  sessionEpoch: prompt.sessionEpoch,
                }
              : undefined,
        },
      });
  };
  const sends = unmatchedSends(header?.sends ?? [], items);
  const jumpToLatest = () => {
    following.current = true;
    setShowJump(false);
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };
  return (
    <section
      className={`chat-window${view === "expanded" ? " expanded" : ""}`}
      role="dialog"
      aria-label={`${title} chat`}
    >
      <header className="chat-header">
        <span className={`chat-status ${header?.status ?? "unknown"}`} />
        <strong>{title}</strong>
        <span className="spacer" />
        <details className="chat-menu">
          <summary className="chat-menu-trigger" aria-label="Chat menu">
            ⋯
          </summary>
          <div>
            <button type="button" onClick={openTerminal}>
              Open terminal
            </button>
            {target.kind === "lead" ? (
              <button
                type="button"
                onClick={() =>
                  void store
                    .command({
                      kind: "stop_lead_session",
                      repoId: target.repoId,
                    })
                    .then((outcome) =>
                      outcome.ok
                        ? store.command({
                            kind: "open_lead_session",
                            repoId: target.repoId,
                          })
                        : outcome,
                    )
                }
              >
                Restart
              </button>
            ) : null}
          </div>
        </details>
        <button
          type="button"
          aria-label="Minimize chat"
          onClick={() => store.setChatView("minimized")}
        >
          –
        </button>
        <button
          type="button"
          aria-label={view === "expanded" ? "Collapse chat" : "Expand chat"}
          onClick={() =>
            store.setChatView(view === "expanded" ? "open" : "expanded")
          }
        >
          {view === "expanded" ? "⤡" : "⤢"}
        </button>
        <button
          type="button"
          aria-label="Close chat"
          onClick={() => store.closeChat()}
        >
          ×
        </button>
      </header>
      <div
        ref={conversation}
        className="chat-conversation"
        onScroll={() => {
          const element = conversation.current;
          if (!element) return;
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <=
            24;
          following.current = atBottom;
          setShowJump(!atBottom);
        }}
      >
        {header?.truncated && (
          <div className="chat-notice">Earlier messages not shown</div>
        )}
        {header?.error && (
          <div role="alert" className="chat-notice">
            {header.error}
          </div>
        )}
        {header?.status === "stopped" && target.kind === "lead" ? (
          <div className="chat-empty">
            Main is not running.
            <button
              type="button"
              onClick={() =>
                void store.command({
                  kind: "open_lead_session",
                  repoId: target.repoId,
                })
              }
            >
              Start Main
            </button>
          </div>
        ) : null}
        {!items.length && header?.status !== "stopped" && !header?.error ? (
          <div className="chat-empty">No messages yet.</div>
        ) : null}
        {items.map((item) =>
          item.kind === "text" ? (
            <div key={item.id} className={`chat-message ${item.role}`}>
              {item.role === "assistant" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {item.text}
                </ReactMarkdown>
              ) : (
                item.text
              )}
            </div>
          ) : (
            <details key={item.id} className="chat-tool">
              <summary>
                {item.kind === "tool"
                  ? `${item.tool?.name} · ${item.tool?.status}`
                  : "Thinking"}
              </summary>
              {item.tool ? (
                <>
                  <pre>{item.tool.input}</pre>
                  <pre>{item.tool.output}</pre>
                </>
              ) : (
                <div>{item.text}</div>
              )}
            </details>
          ),
        )}
        {header?.status === "working" && (
          <div className="chat-working">Working…</div>
        )}
        {header?.pendingPrompt && (
          <div className="chat-prompt">
            <strong>
              {header.pendingPrompt.source === "codex_request"
                ? header.pendingPrompt.summary
                : `${header.pendingPrompt.tool} permission`}
            </strong>
            {header.pendingPrompt.source === "claude_dialog" &&
            header.pendingPrompt.kind === "input" ? (
              <button type="button" onClick={openTerminal}>
                Answer in terminal
              </button>
            ) : (
              <>
                <button type="button" onClick={() => answer(1)}>
                  Yes
                </button>
                {header.pendingPrompt.source === "claude_dialog" && (
                  <button type="button" onClick={() => answer(2)}>
                    Yes, don't ask again
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    answer(
                      header.pendingPrompt?.source === "claude_dialog"
                        ? 3
                        : "escape",
                    )
                  }
                >
                  No
                </button>
              </>
            )}
          </div>
        )}
        {sends.map((send) => (
          <div
            key={send.id}
            className={`chat-send ${send.state}`}
            title={send.reason ?? undefined}
          >
            {send.text}
            <small>
              {send.state}
              {send.reason ? ` · ${send.reason}` : ""}
            </small>
          </div>
        ))}
        <div ref={end} />
        {showJump && (
          <button
            type="button"
            className="chat-jump-latest"
            onClick={jumpToLatest}
          >
            Jump to latest
          </button>
        )}
      </div>
      <div className="chat-composer">
        <div className="chat-future-slot" />
        {/* Future slash-command picker. */}
        <textarea
          ref={composer}
          value={text}
          disabled={header?.status === "stopped"}
          placeholder={`Message ${title}…`}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") store.setChatView("minimized");
            else if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="chat-send-button"
          aria-label="Send message"
          disabled={
            !text.trim() ||
            prefixError ||
            sending ||
            header?.status === "stopped"
          }
          onClick={() => void send()}
        >
          ↑
        </button>
      </div>
      {prefixError && (
        <div className="chat-error">
          Messages beginning with / or ! are not allowed.
        </div>
      )}
    </section>
  );
}
