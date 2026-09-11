import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePatchFiles } from "@pierre/diffs";
import { DiffParser, DiffFile } from "@git-diff-view/core";
import { fixtureSchema } from "../src/schema.ts";

const root = join(tmpdir(), "loom-spike-04");
const f = fixtureSchema.parse(JSON.parse(readFileSync(join(root, "data/edges.json"), "utf8")));
const parser = new DiffParser();
const chunks = f.patch.split(/(?=^diff --git )/m).filter(Boolean);
const results: Record<string, unknown> = {
  reason: "Pierre 1.4.2 leaves Git octal-escaped Unicode filenames encoded",
  pierreQuotedNames: parsePatchFiles(f.patch, "quoted", true).flatMap((p) =>
    p.files.map((f) => f.name),
  ),
  fallbackPerFile: chunks.map((patch) => {
    const result = parser.parse(patch);
    return { isBinary: result.isBinary, hunks: result.hunks.length, keys: Object.keys(result) };
  }),
};
const edge = join(root, "edge-repo");
const unicodePatch = f.patch
  .replaceAll('"a/space \\303\\274.txt"', "a/space ü.txt")
  .replaceAll('"b/space \\303\\274.txt"', "b/space ü.txt");
results.pierreLiteralUnicodeNames = parsePatchFiles(unicodePatch, "literal", true).flatMap((p) =>
  p.files.map((f) => f.name),
);
// Confirm Git can emit literal Unicode without modifying any global config.
const name = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "space*"], {
  cwd: edge,
  encoding: "utf8",
}).trim();
results.gitLiteralFilename = name;
const previous = readFileSync(join(edge, name), "utf8");
try {
  writeFileSync(join(edge, name), "literal Unicode probe\n");
  const literalPatch = execFileSync("git", ["-c", "core.quotePath=false", "diff", "--", name], {
    cwd: edge,
    encoding: "utf8",
  });
  results.pierreFromGitLiteralPatch = parsePatchFiles(literalPatch, "git-literal", true).flatMap(
    (p) => p.files.map((f) => f.name),
  );
} finally {
  writeFileSync(join(edge, name), previous);
}
const fallback = new DiffFile(name, "old\n", name, "new\n", [
  chunks.find((p) => p.includes("space "))!,
]);
fallback.initRaw();
results.fallbackCallerSuppliedName = { old: fallback._oldFileName, new: fallback._newFileName };
writeFileSync(join(root, "comparison.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
