import { appendFile, copyFile, mkdtemp, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readConversation } from "./transcript.js";

describe("Claude transcript conversation", () => {
  test("normalizes, merges tools, appends incrementally and resets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-transcript-"));
    const path = join(dir, "session.jsonl");
    await copyFile(
      new URL("./fixtures/conversation.jsonl", import.meta.url),
      path,
    );
    const request = {
      sessionId: "session-a" as never,
      cwd: dir as never,
      transcriptPath: path,
    };
    const first = await readConversation(request);
    expect(first.items.map((item) => item.kind)).toEqual([
      "text",
      "thinking",
      "tool",
      "text",
    ]);
    expect(first.items[2]?.tool).toMatchObject({
      name: "Read",
      status: "done",
      output: "Example output",
    });
    await appendFile(
      path,
      '{"type":"assistant","uuid":"a2","timestamp":"2026-09-14T01:00:04.000Z","message":{"role":"assistant","content":"Done"}}\n',
    );
    expect((await readConversation(request)).items.at(-1)?.text).toBe("Done");
    await truncate(path, 0);
    expect((await readConversation(request)).items).toEqual([]);
  });
});
