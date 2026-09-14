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

export type ChatTimelineEntry =
  | { kind: "item"; item: ConversationItem }
  | { kind: "send"; send: Conversation["sends"][number] };

export function chatTimeline(
  sends: Conversation["sends"],
  items: ConversationItem[],
): ChatTimelineEntry[] {
  const matched = new Map<number, number>();
  let after = 0;
  sends.forEach((send, sendIndex) => {
    const index = items.findIndex(
      (item, itemIndex) =>
        itemIndex >= after &&
        item.role === "user" &&
        item.kind === "text" &&
        comparableText(item.text) === comparableText(send.text),
    );
    if (index >= 0) {
      matched.set(sendIndex, index);
      after = index + 1;
    }
  });
  const slots = Array.from(
    { length: items.length + 1 },
    () => [] as Conversation["sends"],
  );
  const timestamped = items.some((item) => item.at !== null);
  sends.forEach((send, sendIndex) => {
    if (
      matched.has(sendIndex) ||
      (send.when === "after_turn" && send.state === "queued")
    )
      return;
    let slot = items.length;
    if (timestamped) {
      slot = 0;
      items.forEach((item, itemIndex) => {
        if (item.at && item.at <= send.at) slot = itemIndex + 1;
      });
    } else {
      const next = [...matched.entries()].find(([index]) => index > sendIndex);
      if (next) slot = next[1];
    }
    slots[slot]?.push(send);
  });
  const result: ChatTimelineEntry[] = [];
  items.forEach((item, index) => {
    for (const send of slots[index] ?? []) result.push({ kind: "send", send });
    result.push({ kind: "item", item });
  });
  for (const send of slots[items.length] ?? [])
    result.push({ kind: "send", send });
  return result;
}

type ComposerAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
};

const fileBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read file"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });

export function ChatWindow() {
  const store = useStoreApi();
  const target = useStore((s) => s.ui.chatTarget);
  const view = useStore((s) => s.ui.chatView);
  const state = useStore((s) => s);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
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
    requestAnimationFrame(() => composer.current?.focus());
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
  const stageFiles = async (files: File[]) => {
    setAttachmentError(null);
    try {
      for (const file of files) {
        const outcome = await store.command({
          kind: "stage_attachment",
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          dataBase64: await fileBase64(file),
        });
        if (!outcome.ok) throw new Error(outcome.error.message);
        if (outcome.result.kind !== "attachment_staged")
          throw new Error("Attachment was not staged");
        const staged = outcome.result;
        setAttachments((current) => [
          ...current,
          {
            id: staged.attachmentId,
            name: staged.name,
            mediaType: staged.mediaType,
            size: file.size,
          },
        ]);
      }
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const send = async (when: "now" | "after_turn" = "now") => {
    const value =
      text.trim() ||
      (attachments.length ? "Please review the attached files." : "");
    if (!value || prefixError || sending) return;
    setSending(true);
    const outcome =
      target.kind === "lead"
        ? await store.command({
            kind: "send_lead_message",
            repoId: target.repoId,
            text: value,
            clientMessageId: crypto.randomUUID(),
            when,
            attachmentIds: attachments.map((value) => value.id),
          })
        : run && task
          ? await store.command({
              kind: "human",
              taskId: task.id,
              command: {
                type: "send_message",
                runId: run.id,
                text: value,
                when,
                attachmentIds: attachments.map((value) => value.id),
                expectedRun: {
                  sessionEpoch: run.sessionEpoch,
                  attempts: run.attempts,
                },
              },
            })
          : null;
    if (outcome?.ok) {
      setText("");
      setAttachments([]);
    }
    setSending(false);
  };
  const stop = () => {
    if (target.kind === "lead")
      void store.command({ kind: "interrupt_lead", repoId: target.repoId });
    else if (run)
      void store.command({
        kind: "human",
        taskId: run.taskId,
        command: {
          type: "interrupt_run",
          runId: run.id,
          expectedRun: {
            sessionEpoch: run.sessionEpoch,
            attempts: run.attempts,
          },
        },
      });
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
  const timeline = chatTimeline(header?.sends ?? [], items);
  const queued = (header?.sends ?? []).filter(
    (send) => send.when === "after_turn" && send.state === "queued",
  );
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
        {timeline.map((entry) => {
          if (entry.kind === "send")
            return (
              <div
                key={`send:${entry.send.id}`}
                className={`chat-send ${entry.send.state}`}
                title={entry.send.reason ?? undefined}
              >
                {entry.send.text}
                <small>
                  {entry.send.state}
                  {entry.send.reason ? ` · ${entry.send.reason}` : ""}
                </small>
              </div>
            );
          const item = entry.item;
          return item.kind === "text" ? (
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
          );
        })}
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
        {queued.length ? (
          <div className="chat-queued">
            <strong>Queued</strong>
            {queued.map((send) => (
              <div key={send.id}>{send.text}</div>
            ))}
          </div>
        ) : null}
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
      <fieldset
        className="chat-composer"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void stageFiles([...event.dataTransfer.files]);
        }}
      >
        {attachments.length ? (
          <div className="chat-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="chat-attachment">
                {attachment.name}{" "}
                <small>
                  {Math.max(1, Math.ceil(attachment.size / 1024))} KB
                </small>
                <button
                  type="button"
                  className="chat-attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((value) => value.id !== attachment.id),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={composer}
          value={text}
          disabled={header?.status === "stopped"}
          placeholder={`Message ${title}…`}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onPaste={(event) => {
            const images = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (images.length) void stageFiles(images);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") store.setChatView("minimized");
            else if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send(header?.status === "working" ? "after_turn" : "now");
            }
          }}
        />
        <div className="chat-composer-actions">
          <div>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void stageFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="chat-icon-button"
              aria-label="Attach files"
              onClick={() => picker.current?.click()}
            >
              📎
            </button>
            {window.loomHost.platform === "darwin" ? (
              <button
                type="button"
                className="chat-icon-button"
                aria-label="Dictate message"
                onClick={() => {
                  composer.current?.focus();
                  void window.loomHost.startDictation();
                }}
              >
                🎙
              </button>
            ) : null}
          </div>
          <div className="chat-send-actions">
            {header?.status === "working" ? (
              <>
                <button
                  type="button"
                  className="chat-stop-button"
                  aria-label="Stop turn"
                  onClick={stop}
                >
                  ■
                </button>
                {text.trim() || attachments.length ? (
                  <>
                    <button
                      type="button"
                      disabled={prefixError || sending}
                      onClick={() => void send("now")}
                    >
                      Steer
                    </button>
                    <button
                      type="button"
                      disabled={prefixError || sending}
                      onClick={() => void send("after_turn")}
                    >
                      Send after turn
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="chat-send-button"
                aria-label="Send message"
                disabled={
                  (!text.trim() && !attachments.length) ||
                  prefixError ||
                  sending ||
                  header?.status === "stopped"
                }
                onClick={() => void send("now")}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </fieldset>
      {(prefixError || attachmentError) && (
        <div className="chat-error">
          {prefixError
            ? "Messages beginning with / or ! are not allowed."
            : attachmentError}
        </div>
      )}
    </section>
  );
}
