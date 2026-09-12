// Opt-in: starts one real headless Claude session on the cheapest model.
//
//   LOOM_REAL_PROVIDERS=1 pnpm vitest run packages/adapters/claude/src/real.test.ts
//
// It uses its own temporary directory, its own settings file and its own session ID, and touches
// no session it didn't start. Skipped by default.

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionId, WorktreePath } from "@loom/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ClaudeAdapterHandle, createClaudeAdapter } from "./index.js";

const enabled = process.env.LOOM_REAL_PROVIDERS === "1";
const PROMPT = "Reply with just the word: ok";

const waitFor = async <T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

describe.skipIf(!enabled)("a real headless run", () => {
  let adapter: ClaudeAdapterHandle;
  let dir: string;
  const sessionId = randomUUID() as ProviderSessionId;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "loom-claude-real-"));
    adapter = await createClaudeAdapter({
      mcpServer: { command: "/bin/echo", args: ["loom-mcp-stub"] },
    });
  });

  afterAll(async () => {
    await adapter?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("runs a turn, reports it through hooks, and is resumable afterwards", {
    timeout: 180_000,
  }, async () => {
    const settingsPath = join(dir, "settings.json");
    await adapter.writeSettings(settingsPath);

    await adapter.startHeadless({
      sessionId,
      resume: false,
      cwd: dir as WorktreePath,
      model: "haiku",
      settingsPath,
      readOnly: true,
      prompt: PROMPT,
    });

    const stop = await waitFor(
      async () => (await adapter.hookSummary(sessionId)).lastStop,
      150_000,
    );
    expect(stop.lastAssistantMessage?.toLowerCase()).toContain("ok");

    const summary = await adapter.hookSummary(sessionId);
    // The SessionStart command hook is the only way this event arrives.
    expect(summary.sessionStart?.source).toBe("startup");
    expect(summary.promptSubmits).toHaveLength(1);
    expect(summary.promptSubmits[0]?.textHash).toBe(
      createHash("sha256").update(PROMPT).digest("hex"),
    );
    expect(summary.stopFailure).toBeNull();
    expect(await adapter.activityAt(sessionId)).toBe(summary.lastEventAt);

    expect(await adapter.headlessState(sessionId)).toMatchObject({
      exited: false,
    });
    // Loom's own session ID reached the transcript, so a retry can resume it.
    expect(await adapter.resumable(sessionId, dir as WorktreePath)).toBe(true);

    // `claude agents --json` must stay parseable against whatever else is running.
    expect(Array.isArray(await adapter.listSessions())).toBe(true);
  });
});
