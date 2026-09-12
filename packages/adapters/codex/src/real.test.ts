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
      const generation = adapter.generation();
      await adapter.reconnect();
      expect(adapter.generation()).toBeGreaterThan(generation ?? 0);
    } finally {
      await adapter.stopServer();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
