import type { ConversationTarget } from "@loom/protocol";
import { repoId as parseRepoId } from "@loom/protocol";
import type { StoreContext } from "./store.js";
import type { UiState } from "./ui-state.js";

export function chatActions(ctx: StoreContext) {
  return {
    openChat(chatTarget: ConversationTarget) {
      ctx.setUi({ chatTarget, chatView: "open" });
    },
    toggleMainChat() {
      const { ui } = ctx.get();
      if (!ui.repo) return;
      const target = {
        kind: "lead" as const,
        repoId: parseRepoId.parse(ui.repo),
      };
      const same =
        ui.chatTarget?.kind === "lead" &&
        ui.chatTarget.repoId === target.repoId;
      ctx.setUi({
        chatTarget: target,
        chatView: same && ui.chatView !== "minimized" ? "minimized" : "open",
      });
    },
    setChatView(chatView: UiState["chatView"]) {
      ctx.setUi({ chatView });
    },
    closeChat() {
      ctx.setUi({ chatTarget: null, chatView: "minimized" });
    },
  };
}
