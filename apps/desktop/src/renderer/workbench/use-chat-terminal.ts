import type { ConversationTarget, PaneView } from "@loom/protocol";
import { useEffect, useRef } from "react";
import type { useStoreApi } from "../store/react.js";

type Store = ReturnType<typeof useStoreApi>;

export const useChatTerminal = ({
  store,
  openMain,
  choose,
}: {
  store: Store;
  openMain: () => void;
  choose: (pane: PaneView) => void;
}) => {
  const openMainRef = useRef(openMain);
  const chooseRef = useRef(choose);
  openMainRef.current = openMain;
  chooseRef.current = choose;
  useEffect(() => {
    const openChatTerminal = (event: Event) => {
      const target = (event as CustomEvent<ConversationTarget>).detail;
      if (target.kind === "lead") return openMainRef.current();
      const pane = store
        .getState()
        .panes.find(
          (candidate) =>
            candidate.runId === target.runId &&
            !candidate.dead &&
            !candidate.unavailable,
        );
      if (pane) chooseRef.current(pane);
    };
    window.addEventListener("loom:open-chat-terminal", openChatTerminal);
    return () =>
      window.removeEventListener("loom:open-chat-terminal", openChatTerminal);
  }, [store]);
};
