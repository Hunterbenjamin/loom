import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAdapter, IsoTime } from "@loom/core";
import { z } from "zod";
import { textHash } from "./hooks.js";

// The SDK returns the native timestamp although SessionMessage's type omits it.
// Validate it here: a user message without an attempt timestamp is not a receipt.
const submission = z.object({
  type: z.literal("user"),
  uuid: z.string().min(1),
  session_id: z.string(),
  timestamp: z.string().datetime(),
  parent_tool_use_id: z.null(),
  is_meta: z.literal(false).optional(),
  message: z.object({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.literal("text"), text: z.string() })),
    ]),
  }),
});

/** Read only this session's conversation, never terminals or other sessions. */
export const promptReceipt: ClaudeAdapter["promptReceipt"] = async (
  request,
) => {
  const messages = await getSessionMessages(request.sessionId, {
    dir: request.cwd,
  });
  for (const raw of messages) {
    const parsed = submission.safeParse(raw);
    if (!parsed.success) continue;
    const message = parsed.data;
    if (
      message.session_id !== request.sessionId ||
      Date.parse(message.timestamp) < Date.parse(request.after) ||
      Date.parse(message.timestamp) > Date.parse(request.before)
    )
      continue;
    const content = message.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((block) => block.text).join("\n");
    if (textHash(text) === request.textHash)
      return {
        promptId: message.uuid,
        textHash: request.textHash,
        at: message.timestamp as IsoTime,
      };
  }
  return null;
};
