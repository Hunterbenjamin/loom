import type { ConversationRead } from "@loom/core";
import type { Subscription } from "@loom/protocol";
import { expect, test, vi } from "vitest";
import { ConversationViews } from "./conversations.js";

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
