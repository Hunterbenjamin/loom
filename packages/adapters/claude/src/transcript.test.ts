import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readConversation, readTokenUsage } from "./transcript.js";

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
      "tool",
    ]);
    expect(first.items[2]?.tool).toMatchObject({
      name: "Read",
      status: "done",
      output: "Example output",
    });
    expect(first.items[4]?.tool).toMatchObject({
      name: "Write",
      status: "failed",
      output: "Permission denied",
    });
    expect(first.items.map((value) => value.text)).not.toEqual(
      expect.arrayContaining(["hidden", "hidden metadata", "unknown type"]),
    );
    await appendFile(
      path,
      '{"type":"assistant","uuid":"a2","timestamp":"2026-09-14T01:00:04.000Z","message":{"role":"assistant","content":"Done"}}\n',
    );
    expect((await readConversation(request)).items.at(-1)?.text).toBe("Done");
    await truncate(path, 0);
    expect((await readConversation(request)).items).toEqual([]);
  });
  test("keeps UTF-8 intact when an incomplete line splits a character", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-transcript-"));
    const path = join(dir, "session.jsonl");
    const bytes = Buffer.from(
      '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"你好"}}\n',
    );
    const split = bytes.indexOf(Buffer.from("你")) + 1;
    await writeFile(path, bytes.subarray(0, split));
    const request = {
      sessionId: "session-utf8" as never,
      cwd: dir as never,
      transcriptPath: path,
    };
    expect((await readConversation(request)).items).toEqual([]);
    await appendFile(path, bytes.subarray(split));
    expect((await readConversation(request)).items[0]?.text).toBe("你好");
  });
});

test("token usage deduplicates message IDs across sidechains and subagent transcripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-transcript-usage-"));
  const path = join(dir, "session.jsonl");
  const row = (
    id: string,
    input: number,
    created: number,
    cached: number,
    output: number,
    thinking?: number,
    sidechain = false,
  ) =>
    JSON.stringify({
      type: "assistant",
      uuid: `${id}-line`,
      isSidechain: sidechain,
      message: {
        id,
        role: "assistant",
        content: "done",
        usage: {
          input_tokens: input,
          cache_creation_input_tokens: created,
          cache_read_input_tokens: cached,
          output_tokens: output,
          ...(thinking === undefined ? {} : { thinking_tokens: thinking }),
        },
      },
    });
  await writeFile(
    path,
    `${row("m1", 10, 2, 3, 5, 1)}\n${row("m1", 20, 4, 6, 8, 2)}\n${row("side", 1, 0, 0, 2, undefined, true)}\n`,
  );
  const subagents = join(dir, "usage-session", "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(
    join(subagents, "agent.jsonl"),
    `${row("m1", 30, 5, 7, 9, 3)}\n${row("sub", 4, 1, 2, 6)}\n`,
  );
  const request = {
    sessionId: "usage-session" as never,
    cwd: dir as never,
    transcriptPath: path,
  };
  const expected = { input: 50, cachedInput: 9, output: 17, reasoning: 3 };
  expect(await readTokenUsage(request)).toEqual(expected);
  expect(await readTokenUsage(request)).toEqual(expected);
});
