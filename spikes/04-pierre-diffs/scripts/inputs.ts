import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { parsePatchFiles, parseDiffFromFile } from "@pierre/diffs";
import { fixtureSchema, manifestSchema } from "../src/schema.ts";

const root = join(tmpdir(), "loom-spike-04");
const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(join(root, "data/manifest.json"), "utf8")),
);
const results: unknown[] = [];
for (const entry of manifest) {
  const f = fixtureSchema.parse(
    JSON.parse(readFileSync(join(root, "data", `${entry.id}.json`), "utf8")),
  );
  const start = performance.now();
  const parsed = parsePatchFiles(f.patch, f.sha256, true).flatMap((p) => p.files);
  const result = {
    id: f.id,
    expectedFiles: f.files,
    parsedFiles: parsed.length,
    parseMs: performance.now() - start,
    inputBytes: Buffer.byteLength(f.patch),
    contentsLines: Object.values(f.contents).map(
      (c) => c.new.split("\n").length - Number(c.new.endsWith("\n")),
    ),
    files: parsed.map((p) => ({
      name: p.name,
      prevName: p.prevName,
      type: p.type,
      partial: p.isPartial,
      hunks: p.hunks.length,
      added: p.hunks.reduce((n, h) => n + h.additionLines, 0),
      deleted: p.hunks.reduce((n, h) => n + h.deletionLines, 0),
    })),
  };
  assert.equal(result.parsedFiles, f.files);
  assert.equal(
    result.files.reduce((n, p) => n + p.added, 0),
    f.added,
  );
  assert.equal(
    result.files.reduce((n, p) => n + p.deleted, 0),
    f.deleted,
  );
  results.push(result);
  console.log(
    JSON.stringify({
      ...result,
      files: f.id === "edges" ? result.files : undefined,
      contentsLines: f.id === "single" || f.id === "lockfile" ? result.contentsLines : undefined,
    }),
  );
}
for (const [id, patch] of [
  ["nonsense", "not a patch\n"],
  ["truncated-hunk", "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n-a\n+b\n"],
] as const) {
  try {
    const files = parsePatchFiles(patch, id, true).flatMap((p) => p.files);
    results.push({
      id,
      accepted: true,
      parsedFiles: files.length,
      hunks: files.map((f) => f.hunks),
    });
    console.log(JSON.stringify({ id, accepted: true, parsedFiles: files.length }));
  } catch (error) {
    results.push({ id, accepted: false, error: String(error) });
    console.log(JSON.stringify({ id, accepted: false, error: String(error) }));
  }
}
const old = "const value = 1;\r\nconst same = true;\r\n";
const next = "const value = 2;\r\nconst same = true;\r\n";
const crlf = parseDiffFromFile(
  { name: "crlf.ts", contents: old },
  { name: "crlf.ts", contents: next },
);
results.push({
  id: "crlf-contents",
  hunks: crlf.hunks.length,
  oldRoundtrip: crlf.deletionLines.join("") === old,
  newRoundtrip: crlf.additionLines.join("") === next,
});
writeFileSync(join(root, "inputs.json"), JSON.stringify(results, null, 2));
