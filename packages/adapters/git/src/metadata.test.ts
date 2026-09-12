import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseDirty, parseHunks, parseNumstat, parseRaw } from "./metadata.js";

const fixture = z
  .object({
    raw: z.string(),
    numstat: z.string(),
    patch: z.string(),
    status: z.string(),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL("./fixtures/git-2.51.2.json", import.meta.url),
        "utf8",
      ),
    ),
  );

describe("recorded Git metadata", () => {
  it("preserves unusual paths and binary metadata without parsing patch paths", () => {
    const raw = parseRaw(Buffer.from(fixture.raw));
    expect(raw.map((r) => r.change.status)).toEqual([
      "added",
      "deleted",
      "added",
      "renamed",
    ]);
    expect(raw[3]?.change).toMatchObject({
      oldPath: 'old"雪\n.txt',
      newPath: 'new"葉\n.txt',
    });
    expect(
      parseNumstat(Buffer.from(fixture.numstat)).map((r) => r.binary),
    ).toEqual([true, false, false, false]);
    expect(parseDirty(Buffer.from(fixture.status))).toEqual([
      'new"葉\n.txt',
      "untracked 雪",
    ]);
    expect(parseHunks(fixture.patch)).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
    ]);
  });
  it("rejects truncated and malformed records instead of returning a clean diff", () => {
    expect(() => parseRaw(Buffer.from(fixture.raw.slice(0, -1)))).toThrow();
    expect(() => parseRaw(Buffer.from(":bad\0file\0"))).toThrow();
    expect(() =>
      parseRaw(Buffer.from(fixture.raw.replace(/R\d+/, "X"))),
    ).toThrow();
    expect(() => parseDirty(Buffer.from("?? \0"))).toThrow();
    expect(() => parseDirty(Buffer.from("R  target\0"))).toThrow();
    expect(() => parseNumstat(Buffer.from("-\t1\tfile\0"))).toThrow();
    expect(() => parseHunks("@@ invalid @@")).toThrow();
  });
});
