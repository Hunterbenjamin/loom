import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createBriefResearch } from "./brief-research.js";

test.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "web-only research returns a validated brief from the real provider",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "loom-test-brief-research-"));
    const sessionId = randomUUID();
    const controller = new AbortController();
    try {
      // Save this experiment's provider identity before launching, just as the coordinator does.
      await writeFile(
        join(cwd, "identity.json"),
        JSON.stringify({ sessionId }),
        { mode: 0o600 },
      );
      const result = await createBriefResearch(
        process.env.LOOM_CLAUDE ?? "claude",
      )({
        sessionId,
        cwd,
        model: "haiku",
        controller,
        prompt:
          "This is a brief research integration smoke test, not a news roundup. Make one live WebFetch of https://info.arxiv.org/about/index.html (use WebSearch only if needed). Return the required structured output with one research item explaining that arXiv does not itself peer-review submissions, citing that exact source. Use short plain-text fields, publishedOn=null, evidence=author_reported, opportunity=null. Do not fetch additional topics or use any local tools.",
      });
      expect(result.items).toHaveLength(1);
      expect(
        result.items[0]?.sources.some(
          (source) => source.url === "https://info.arxiv.org/about/index.html",
        ),
      ).toBe(true);
    } finally {
      controller.abort();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  180_000,
);
