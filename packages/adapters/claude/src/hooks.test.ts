// Recorded hook payloads (spike 02) posted to the real receiver, then folded.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IsoTime, ProviderSessionId } from "@loom/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { HookPayload, HookReceipt } from "./hooks.js";
import { foldHookSummary, MemoryHookLog } from "./hooks.js";
import type { HookReceiver } from "./receiver.js";
import { startHookReceiver } from "./receiver.js";

const samples = JSON.parse(
  readFileSync(
    new URL("./fixtures/payload-samples.json", import.meta.url),
    "utf8",
  ),
) as Record<string, HookPayload>;

const SESSION = "6d3b4239-0b4f-4c87-97c5-ee6146088430" as ProviderSessionId;

/** Samples were recorded across two sessions; the fold is per session, so they're rehomed. */
const sample = (
  name: string,
  overrides: Partial<HookPayload> = {},
): HookPayload => {
  const found = samples[name];
  if (!found) throw new Error(`no sample ${name}`);
  return { ...found, session_id: SESSION, ...overrides };
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

describe("hook receiver and fold", () => {
  let log: MemoryHookLog;
  let receiver: HookReceiver;
  let receipts: HookReceipt[];
  let errors: Error[];
  let clock: number;

  const post = async (payload: HookPayload): Promise<Response> =>
    fetch(`${receiver.baseUrl}/hook/${payload.hook_event_name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const summary = async (session: ProviderSessionId = SESSION) =>
    foldHookSummary(await log.bySession(session));

  beforeEach(async () => {
    log = new MemoryHookLog();
    receipts = [];
    errors = [];
    clock = Date.parse("2026-09-11T10:45:00.000Z");
    receiver = await startHookReceiver({
      log,
      onReceipt: (receipt) => receipts.push(receipt),
      onError: (error) => errors.push(error),
      now: () => {
        clock += 1000;
        return new Date(clock).toISOString() as IsoTime;
      },
    });
  });

  afterEach(async () => {
    await receiver.close();
  });

  test("binds loopback and answers every hook 200 with an empty object", async () => {
    expect(receiver.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await post(sample("SessionStart:startup"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test("folds a permission turn: dialog opens on PermissionRequest, closes on PostToolUse", async () => {
    await post(sample("SessionStart:startup"));
    await post(sample("UserPromptSubmit"));
    await post(sample("PreToolUse"));
    await post(sample("PermissionRequest:Bash"));
    await post(sample("Notification:permission_prompt"));

    const waiting = await summary();
    expect(waiting.sessionStart).toEqual({
      source: "startup",
      at: "2026-09-11T10:45:01.000Z",
    });
    expect(waiting.pendingDialog).toEqual({
      kind: "permission",
      tool: "Bash",
      at: "2026-09-11T10:45:04.000Z",
    });
    expect(waiting.promptSubmits).toEqual([
      {
        promptId: "55227528-303d-438a-afb3-a4ccdcf75837",
        textHash: sha256("Reply with just the word: ok"),
        at: "2026-09-11T10:45:02.000Z",
      },
    ]);
    expect(waiting.lastStop).toBeNull();

    await post(sample("PostToolUse"));
    await post(sample("Stop"));

    const done = await summary();
    expect(done.pendingDialog).toBeNull();
    expect(done.lastStop).toEqual({
      promptId: "55227528-303d-438a-afb3-a4ccdcf75837",
      at: "2026-09-11T10:45:07.000Z",
      lastAssistantMessage: "ok",
    });
    expect(done.lastEventAt).toBe("2026-09-11T10:45:07.000Z");
    expect(done.stopFailure).toBeNull();
  });

  test("AskUserQuestion is an input dialog, not a permission", async () => {
    await post(sample("PermissionRequest:AskUserQuestion"));
    expect((await summary()).pendingDialog).toEqual({
      kind: "input",
      tool: "AskUserQuestion",
      at: "2026-09-11T10:45:01.000Z",
    });
  });

  test("a PostToolUse for another tool leaves the dialog pending", async () => {
    await post(sample("PermissionRequest:AskUserQuestion"));
    await post(sample("PostToolUse"));
    expect((await summary()).pendingDialog).toMatchObject({
      kind: "input",
      tool: "AskUserQuestion",
    });
  });

  test("internal subagent events are logged but not folded", async () => {
    await post(sample("UserPromptSubmit"));
    await post(sample("SubagentStop:sub"));

    expect((await summary()).lastEventAt).toBe("2026-09-11T10:45:01.000Z");
    // The receipt log still keeps it: hooks can't be re-read from Claude.
    expect((await log.bySession(SESSION)).map((r) => r.event)).toEqual([
      "UserPromptSubmit",
      "SubagentStop",
    ]);
  });

  test("a named subagent is folded", async () => {
    await post(sample("SubagentStop:sub", { agent_type: "code-reviewer" }));
    expect((await summary()).lastEventAt).toBe("2026-09-11T10:45:01.000Z");
    expect(receipts).toHaveLength(1);
  });

  test("prompt hashes are normalized: tabs to four spaces, CRLF to LF", async () => {
    await post(sample("UserPromptSubmit", { prompt: "a\tb\r\nc" }));
    expect((await summary()).promptSubmits[0]?.textHash).toBe(
      sha256("a    b\nc"),
    );
  });

  test("SessionEnd and a later SessionStart both survive the fold", async () => {
    await post(sample("SessionEnd:prompt_input_exit"));
    await post(sample("SessionStart:resume"));
    const folded = await summary();
    expect(folded.sessionEnd).toEqual({
      reason: "prompt_input_exit",
      at: "2026-09-11T10:45:01.000Z",
    });
    expect(folded.sessionStart).toEqual({
      source: "resume",
      at: "2026-09-11T10:45:02.000Z",
    });
  });

  test("StopFailure folds even though spike 02 never triggered one", async () => {
    await post(
      sample("Stop", {
        hook_event_name: "StopFailure",
        error: "API Error: 529 overloaded",
      }),
    );
    expect((await summary()).stopFailure).toEqual({
      error: "API Error: 529 overloaded",
      at: "2026-09-11T10:45:01.000Z",
    });
  });

  test("sessions are kept apart", async () => {
    const other = "9b87a656-3e3b-4c6c-b89c-26514a09917f" as ProviderSessionId;
    await post(sample("UserPromptSubmit"));
    await post(sample("UserPromptSubmit", { session_id: other }));

    expect((await summary()).promptSubmits).toHaveLength(1);
    expect((await summary(other)).promptSubmits).toHaveLength(1);
  });

  test("hints carry the session and the realpath cwd", async () => {
    await post(sample("UserPromptSubmit"));
    expect(receipts[0]).toMatchObject({
      seq: 1,
      sessionId: SESSION,
      event: "UserPromptSubmit",
      promptId: "55227528-303d-438a-afb3-a4ccdcf75837",
    });
    expect(receipts[0]?.payload.cwd).toBe(
      "/private/var/folders/q4/40hztcsn5pl4nj5rx75sgzlr0000gn/T/loom-spike-02/repo",
    );
  });

  test("an invalid payload is dropped, and the session still sees 200", async () => {
    const response = await fetch(`${receiver.baseUrl}/hook/Stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(response.status).toBe(200);
    expect(await log.bySession(SESSION)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/invalid hook payload/);
  });

  test("unknown fields are kept in the receipt", async () => {
    await post(sample("Stop", { some_new_field: 42 } as Partial<HookPayload>));
    const stored = await log.bySession(SESSION);
    expect(stored[0]?.payload).toMatchObject({ some_new_field: 42 });
  });

  test("an empty log folds to an empty summary", async () => {
    expect(await summary()).toEqual({
      lastEventAt: null,
      pendingDialog: null,
      promptSubmits: [],
      lastStop: null,
      stopFailure: null,
      sessionStart: null,
      sessionEnd: null,
    });
  });
});
