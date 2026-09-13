import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IsoTime, ProviderSessionId, WorktreePath } from "@loom/core";
import { expect, test, vi } from "vitest";
import { textHash } from "./hooks.js";
import { promptReceipt } from "./receipts.js";

test("installed SDK preserves submission timestamp from an owned transcript without hooks", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "loom-transcript-")),
  );
  const config = join(root, "claude");
  const cwd = join(root, "headless") as WorktreePath;
  const id = randomUUID() as ProviderSessionId;
  const promptId = randomUUID();
  const at = "2026-09-13T07:59:00.000Z" as IsoTime;
  const text = "Message from Main: hello";
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.stubEnv("CLAUDE_CODE_PROJECT_DIR_NAME", "");
  try {
    await mkdir(cwd, { recursive: true });
    const project = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: "user",
        uuid: promptId,
        sessionId: id,
        cwd,
        timestamp: at,
        parentUuid: null,
        isSidechain: false,
        message: { role: "user", content: text },
      })}\n`,
    );
    expect(
      await promptReceipt({
        sessionId: id,
        cwd,
        textHash: textHash(text),
        after: at,
        before: at,
      }),
    ).toEqual({ promptId, textHash: textHash(text), at });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
