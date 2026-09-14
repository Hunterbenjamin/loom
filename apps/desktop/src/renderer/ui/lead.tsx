import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { ChatWindow } from "../chat/chat-window.js";
import { inboxRows } from "../store/inbox.js";
import { readyToMergeCount } from "../store/pull-requests.js";
import { useStore, useStoreApi } from "../store/react.js";
import { useWindowMode } from "../window-mode.js";
import { ChimeMuteButton } from "../workbench/chime.js";
import { attentionPanes } from "../workbench/selectors.js";

export function LeadBar({
  onAttention,
  keybindingStatus,
}: {
  onAttention?: () => void;
  keybindingStatus?: ReactNode;
} = {}) {
  const mode = useWindowMode();
  const store = useStoreApi();
  const toggle = useRef<HTMLButtonElement>(null);
  const connection = useStore((s) => s.connection);
  const instance = useStore((s) => s.instance);
  const readyCount = useStore(readyToMergeCount);
  const count = useStore((s) => inboxRows(s).length);
  const status = useStore((s) => s.lead.status);
  const repo = useStore((s) => s.ui.repo);
  const chatTarget = useStore((s) => s.ui.chatTarget);
  const chatView = useStore((s) => s.ui.chatView);
  const agentCount = useStore((s) => attentionPanes(s.panes).length);
  const mainOpen =
    chatTarget?.kind === "lead" &&
    chatTarget.repoId === repo &&
    chatView !== "minimized";
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        store.toggleMainChat();
      }
    };
    const show = () =>
      repo && store.openChat({ kind: "lead", repoId: repo as never });
    window.addEventListener("loom:open-main", show);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("loom:open-main", show);
      window.removeEventListener("keydown", key);
    };
  }, [repo, store]);
  useEffect(() => {
    if (mainOpen && status !== "working") store.markMainRead();
  }, [mainOpen, status, store]);
  useEffect(() => {
    if (!mainOpen && document.activeElement?.closest(".chat-window"))
      toggle.current?.focus();
  }, [mainOpen]);
  return (
    <>
      <ChatWindow />
      <footer className="bottom-bar">
        {keybindingStatus}
        <span className="connection-state">
          <span
            className={
              connection === "connected"
                ? "connection-dot connected"
                : "connection-dot"
            }
          />
          {connection} · {instance}
        </span>
        <button
          type="button"
          onClick={() =>
            void window.loomHost.setMode(
              mode === "tracker" ? "workbench" : "tracker",
            )
          }
        >
          {mode === "tracker" ? "Workbench" : "Issue tracker"} <kbd>⌘⇧W</kbd>
        </button>
        <button
          type="button"
          onClick={
            onAttention ?? (() => void window.loomHost.setMode("workbench"))
          }
        >
          Agents needing attention · {agentCount}
        </button>
        <span>Ready to merge · {readyCount}</span>
        <span className="spacer" />
        <ChimeMuteButton />
        <button
          disabled={!repo}
          ref={toggle}
          type="button"
          className="lead-toggle"
          aria-expanded={mainOpen}
          onClick={() => store.toggleMainChat()}
        >
          <span className={`chat-status ${status}`} /> Main{" "}
          <span className="lead-badge">{count}</span>
          <kbd>⌘J</kbd>
        </button>
      </footer>
    </>
  );
}
