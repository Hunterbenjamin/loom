import { describe, expect, it } from "vitest";
import {
  actionInput,
  command,
  config,
  fixed,
  fixture,
  now,
} from "../test/fixtures.js";
import type { Action, Run, RunObservation } from "./index.js";
import { normalizeText, reconcile } from "./index.js";

function prepared(provider: "codex" | "claude" = "codex", working = false) {
  const f = fixture();
  const run = f.state.runs.find((r) => r.provider === provider) as Run;
  const observation = f.observations.runs.find(
    (o) => o.runId === run.id,
  ) as RunObservation;
  if (
    observation.provider.ok &&
    observation.provider.value?.provider === "codex" &&
    working
  ) {
    observation.provider.value.status = "active";
    observation.provider.value.turns = [
      { id: "turn1", status: "inProgress", error: null, userMessageHashes: [] },
    ];
  }
  f.observations.inputs = [
    command({
      type: "send_message",
      runId: run.id,
      text: "Hello\tworld\r\nNext",
    }),
  ];
  const initial = fixed(f.state, f.observations);
  const action = initial.actions.find(
    (a) => a.kind === "send_message",
  ) as Action;
  f.observations.inputs = [
    actionInput(action, {
      transportRef: provider === "codex" ? "turn1" : null,
    }),
  ];
  const sent = reconcile(initial.next, f.observations);
  return { ...f, run, observation, action, state: sent.next };
}
describe("delivery requires provider evidence", () => {
  it("normalizes tabs and CRLF before hashing", () => {
    expect(normalizeText("A\tB\r\nC")).toBe("A    B\nC");
    const f = prepared();
    expect(f.state.messages[0]?.textHash).toBe(
      config.sha256("Hello    world\nNext"),
    );
  });
  it("transport success marks sent only", () => {
    const f = prepared();
    expect(f.state.messages[0]?.status).toBe("sent");
  });
  it("Codex start snapshot confirms the returned turn", () => {
    const f = prepared();
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "codex"
    )
      f.observation.provider.value.turns = [
        {
          id: "turn1",
          status: "completed",
          error: null,
          userMessageHashes: [],
        },
      ];
    const r = fixed(f.state, f.observations);
    expect(r.next.messages[0]).toMatchObject({
      status: "delivered",
      delivered: { via: "codex_turn_started", turnId: "turn1" },
    });
  });
  it("Codex start rejects a different turn", () => {
    const f = prepared();
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "codex"
    )
      f.observation.provider.value.turns = [
        {
          id: "other",
          status: "completed",
          error: null,
          userMessageHashes: [],
        },
      ];
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("steer requires matching text item in expected turn", () => {
    const f = prepared("codex", true);
    expect(f.state.messages[0]?.status).toBe("sent");
    const p = f.observation.provider;
    if (p.ok && p.value?.provider === "codex" && p.value.turns[0])
      p.value.turns[0].userMessageHashes = [
        f.state.messages[0]?.textHash ?? "",
      ];
    expect(fixed(f.state, f.observations).next.messages[0]).toMatchObject({
      status: "delivered",
      delivered: { via: "codex_user_message_item" },
    });
  });
  it("a written paste alone never delivers", () => {
    const f = prepared("claude");
    f.observation.pane = {
      ok: true,
      at: now,
      value: {
        ref: {
          hostGeneration: "loom-dev#1",
          sessionName: "loom-t1",
          paneId: "%1",
        },
        cwd: f.run.worktreePath,
        startCwd: f.run.worktreePath,
        pid: 4242,
        command: "node",
        dead: false,
        exitCode: null,
      },
    };
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("Claude matches normalized prompt receipt", () => {
    const f = prepared("claude");
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "claude"
    )
      f.observation.provider.value.hooks.promptSubmits = [
        {
          promptId: "prompt1",
          textHash: f.state.messages[0]?.textHash ?? "",
          at: now,
        },
      ];
    expect(fixed(f.state, f.observations).next.messages[0]).toMatchObject({
      status: "delivered",
      delivered: { via: "claude_user_prompt_submit", promptId: "prompt1" },
    });
  });
  it("unavailable provider cannot confirm a message", () => {
    const f = prepared();
    f.observation.provider = { ok: false, at: now, reason: "Offline" };
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("stale Claude receipt cannot acknowledge identical new text", () => {
    const f = prepared("claude");
    if (
      f.observation.provider.ok &&
      f.observation.provider.value?.provider === "claude"
    )
      f.observation.provider.value.hooks.promptSubmits = [
        {
          promptId: "old",
          textHash: f.state.messages[0]?.textHash ?? "",
          at: "2026-09-11T00:00:00.000Z" as typeof now,
        },
      ];
    expect(fixed(f.state, f.observations).next.messages[0]?.status).toBe(
      "sent",
    );
  });
  it("resends once with same message ID and unique attempt key", () => {
    const f = prepared();
    f.observations.now = "2026-09-12T00:00:11.000Z" as typeof now;
    const r = fixed(f.state, f.observations);
    const retry = r.actions.find((a) => a.kind === "send_message");
    expect(retry).toMatchObject({
      messageId: f.state.messages[0]?.id,
      key: `send_message:${f.state.messages[0]?.id}#2`,
    });
    if (!retry) throw Error("Missing retry");
    f.observations.inputs = [
      actionInput(retry, { transportRef: "turn2" }, "retry-result"),
    ];
    const sent = reconcile(r.next, f.observations);
    f.observations.now = "2026-09-12T00:00:22.000Z" as typeof now;
    const expired = fixed(sent.next, f.observations);
    expect(expired.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(expired.next.task.attention.reasons).toContain("provider_input");
  });
  it("working or new turn at timeout requires human inspection", () => {
    const f = prepared("codex", true);
    f.observations.now = "2026-09-12T00:00:11.000Z" as typeof now;
    const r = fixed(f.state, f.observations);
    expect(r.actions.some((a) => a.kind === "send_message")).toBe(false);
    expect(r.next.task.attention.reasons).toContain("provider_input");
  });
  for (const text of ["/clear", "!rm file", "  /command"])
    it(`prefixes unsafe generated text ${text}`, () => {
      const f = fixture();
      const run = f.state.runs[1] as Run;
      f.observations.inputs = [
        command({ type: "send_message", runId: run.id, text }),
      ];
      const r = fixed(f.state, f.observations);
      expect(r.next.messages[0]?.text).toBe(`Loom message:\n${text}`);
    });
  it("unknown provider blocks send even with a live pane", () => {
    const f = fixture();
    const run = f.state.runs[1] as Run;
    const o = f.observations.runs[1] as RunObservation;
    o.provider = { ok: false, reason: "Offline", at: now };
    f.observations.inputs = [
      command({ type: "send_message", runId: run.id, text: "Hello" }),
    ];
    expect(
      fixed(f.state, f.observations).actions.some(
        (a) => a.kind === "send_message",
      ),
    ).toBe(false);
  });
});
