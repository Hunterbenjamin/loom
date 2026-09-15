import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { ProviderSessionId, WorktreePath } from "@loom/core";
import { expect, it } from "vitest";
import { createCodexAdapter } from "./index.js";

// No model turn or credentials are required by this transport/lifecycle smoke test.
// Any future inference probe must stay opt-in and use the cheapest explicit model.
it.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "real 0.154.0 private app-server lifecycle and thread allocation",
  async () => {
    const directory = await mkdtemp("/tmp/loom-codex-real-");
    const adapter = createCodexAdapter({
      taskDirectory: directory,
      timeoutMs: 15000,
    });
    try {
      await adapter.startServer();
      const allocated = await adapter.startThread({
        cwd: (await realpath(directory)) as WorktreePath,
        model: "gpt-5.6-luna",
        sandbox: "read-only",
        developerInstructions:
          "Only this temporary fixture. Do not spawn agents.",
        config: {},
      });
      expect(allocated.threadId).toBeTruthy();
      expect(await adapter.checkResumable(allocated.threadId)).toBe(true);
      expect(
        await adapter.checkResumable(
          "00000000-0000-7000-8000-000000000000" as ProviderSessionId,
        ),
      ).toBe(false);
    } finally {
      await adapter.stopServer();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "real usage is re-emitted on resume and survives an app-server restart",
  async () => {
    const directory = await mkdtemp("/tmp/loom-codex-usage-real-");
    const adapter = createCodexAdapter({
      taskDirectory: directory,
      timeoutMs: 15000,
    });
    try {
      await adapter.startServer();
      const { threadId } = await adapter.startThread({
        cwd: (await realpath(directory)) as WorktreePath,
        model: "gpt-5.6-luna",
        sandbox: "read-only",
        developerInstructions: "Reply with only OK. Do not use tools.",
        config: {},
      });
      await adapter.startTurn({ threadId, text: "Reply OK" });
      await expect
        .poll(() => adapter.tokenUsage(threadId), { timeout: 60_000 })
        .not.toBeNull();
      const total = adapter.tokenUsage(threadId);

      await adapter.reconnect();
      await expect
        .poll(() => adapter.tokenUsage(threadId), { timeout: 15_000 })
        .toEqual(total);

      await adapter.stopServer();
      await adapter.startServer();
      await expect
        .poll(() => adapter.tokenUsage(threadId), { timeout: 30_000 })
        .toEqual(total);
    } finally {
      await adapter.stopServer();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
