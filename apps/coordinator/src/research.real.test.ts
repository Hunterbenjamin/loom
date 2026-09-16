import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexAdapter } from "@loom/adapter-codex";
import { DEFAULT_SETTINGS } from "@loom/core";
import { expect, test, vi } from "vitest";
import { createHarness } from "./test-support.js";

// Real provider and real Loom HTTP MCP; the pane host remains fake so this probe never
// touches a human's terminals. It exercises the same launch recipe and first-turn path.
test.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "real research reads local evidence and the web, then submits through Loom MCP",
  async () => {
    const h = await createHarness();
    const serverDirectory = await mkdtemp("/tmp/loom-r-");
    const codex = createCodexAdapter({
      taskDirectory: serverDirectory,
      executable: process.env.LOOM_CODEX ?? "codex",
    });
    try {
      h.adapters.codex = async () => {
        await codex.startServer();
        return codex;
      };
      const settings = h.store.settings.read({ kind: "global" });
      h.store.settings.update({
        actor: "test",
        changedAt: h.clock.now(),
        changes: [],
        scope: { kind: "global" },
        expectedVersion: settings.version,
        data: {
          research: {
            ...DEFAULT_SETTINGS.research,
            model: "gpt-5.6-luna",
            depth: "standard",
            reasoningEffort: "low",
          },
        },
      });
      await writeFile(
        join(h.repoRoot, "research-evidence.txt"),
        "The project shortcut is Ctrl+K.\n",
      );
      const entry = await h.coordinator.research.start(
        randomUUID(),
        "Read research-evidence.txt through Loom's scoped file tool and look up https://info.arxiv.org/about/index.html using web search. Submit a short document stating the project's shortcut and what arXiv is, citing the arXiv page. This is a smoke test; one web lookup is enough.",
        h.repoRoot,
      );
      expect(entry.status, entry.error ?? "").toBe("running");
      await vi.waitFor(
        () => {
          const result = h.coordinator.research.read(entry.id);
          expect(result.status).not.toBe("running");
        },
        { timeout: 180000, interval: 1000 },
      );
      const result = h.coordinator.research.read(entry.id);
      expect(result.status, result.error ?? "").toBe("completed");
      expect(result.document?.body).toContain("Ctrl+K");
      expect(result.document?.sources.length).toBeGreaterThan(0);
    } finally {
      await h.coordinator.research.stop();
      await codex.stopServer();
      await h.close();
      await rm(serverDirectory, { recursive: true, force: true });
    }
  },
  200000,
);
