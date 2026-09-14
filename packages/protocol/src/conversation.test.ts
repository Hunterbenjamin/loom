import { describe, expect, test } from "vitest";
import { command, conversationKey, filterChanges, scopeOf } from "./index.js";

describe("conversation protocol", () => {
  test("keys and scopes conversation rows", () => {
    const target = { kind: "run" as const, runId: "run-1" as never };
    expect(conversationKey(target)).toBe("run:run-1");
    const scope = scopeOf([{ kind: "conversation", target }]);
    expect(
      filterChanges(scope, [
        {
          op: "upsert",
          collection: "conversation_item",
          value: {
            conversationKey: "run:run-1",
            order: 0,
            id: "i",
            role: "user",
            kind: "text",
            text: "hi",
            clipped: false,
            tool: null,
            at: null,
          },
        },
      ]),
    ).toHaveLength(1);
  });
  test("validates Main messages", () => {
    const valid = {
      kind: "send_lead_message",
      repoId: "repo" as never,
      clientMessageId: "01234567-89ab-4def-8123-456789abcdef",
      text: " hello ",
    };
    const parsed = command.parse(valid);
    expect(parsed.kind === "send_lead_message" ? parsed.text : null).toBe(
      "hello",
    );
    expect(command.safeParse({ ...valid, text: "/help" }).success).toBe(false);
    expect(command.safeParse({ ...valid, text: "!run" }).success).toBe(false);
    expect(
      command.safeParse({ ...valid, text: "x".repeat(16385) }).success,
    ).toBe(false);
  });
});
