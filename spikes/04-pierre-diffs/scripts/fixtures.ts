import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { fixtureSchema, type Fixture } from "../src/schema.ts";

const root = join(tmpdir(), "loom-spike-04");
const repo = join(root, "vue-core");
const data = join(root, "data");
mkdirSync(data, { recursive: true });
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
const sha = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .parse(git(["rev-parse", "HEAD"]).trim());
const source = `vuejs/core v3.5.21 ${sha}`;
const paths = z
  .array(z.string())
  .parse(git(["ls-files", "packages"]).trim().split("\n"))
  .filter((p) => /\.tsx?$/.test(p) && readFileSync(join(repo, p), "utf8").split("\n").length >= 70);
if (paths.length < 300) throw new Error(`Need 300 source files, got ${paths.length}`);
const manifest: Omit<Fixture, "patch" | "contents">[] = [];
function save(
  id: string,
  description: string,
  patch: string,
  contents: Fixture["contents"],
  fixtureSource = source,
) {
  // Raw patches can contain public contact strings; fixtures stay under TMPDIR, never committed.
  const lines = patch.split("\n");
  const fixture = fixtureSchema.parse({
    id,
    description,
    source: fixtureSource,
    patch,
    contents,
    files: lines.filter((l) => l.startsWith("diff --git ")).length,
    added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    deleted: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
    sha256: createHash("sha256").update(patch).digest("hex"),
  });
  writeFileSync(join(data, `${id}.json`), JSON.stringify(fixture));
  const { patch: _patch, contents: _contents, ...entry } = fixture;
  manifest.push(entry);
  console.log(JSON.stringify(entry));
}
for (const [id, count, total] of [
  ["medium", 50, 1000],
  ["large", 300, 10000],
] as const) {
  const contents: Fixture["contents"] = {};
  const selected = paths.slice(0, count);
  try {
    selected.forEach((path, index) => {
      const old = readFileSync(join(repo, path), "utf8");
      const lines = old.split("\n");
      const edits = Math.floor(total / count) + (index < total % count ? 1 : 0);
      // Real source, deterministic mechanical changes. Not claimed to be an organic PR.
      for (let i = 0; i < edits; i++) {
        const at = Math.floor(((i + 1) * (lines.length - 1)) / (edits + 1));
        lines[at] += ` // loom-spike-${i}`;
      }
      contents[path] = { old, new: lines.join("\n") };
      writeFileSync(join(repo, path), contents[path].new);
    });
    save(
      id,
      `${count} real Vue source files; ${total * 2} mechanically changed lines`,
      git(["diff", "--no-ext-diff", "--no-color", "--", ...selected]),
      contents,
    );
  } finally {
    for (const [path, pair] of Object.entries(contents)) writeFileSync(join(repo, path), pair.old);
  }
}
function pairPatch(path: string, old: string, next: string) {
  for (const side of ["old", "new"]) mkdirSync(join(root, side), { recursive: true });
  writeFileSync(join(root, "old", path), old);
  writeFileSync(join(root, "new", path), next);
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "--", `old/${path}`, `new/${path}`],
    { cwd: root, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
  return result.stdout.replaceAll("a/old/", "a/").replaceAll("b/new/", "b/");
}
const sourceLines = paths
  .flatMap((p) => readFileSync(join(repo, p), "utf8").split("\n"))
  .slice(0, 10000);
const oldSingle = sourceLines.join("\n") + "\n";
const newSingle = sourceLines.map((l, i) => `${l} // stress-${i}`).join("\n") + "\n";
save(
  "single",
  "10,000-line concatenated Vue source stress file, every line modified",
  pairPatch("stress.ts", oldSingle, newSingle),
  { "stress.ts": { old: oldSingle, new: newSingle } },
);
const lockOld = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
let lockEdits = 0;
const lockNew = lockOld
  .split("\n")
  .map((l) => (l.includes("integrity:") && lockEdits++ < 500 ? `${l} # spike` : l))
  .join("\n");
save(
  "lockfile",
  "Real pnpm-lock.yaml, 500 mechanically edited integrity lines",
  pairPatch("pnpm-lock.yaml", lockOld, lockNew),
  { "pnpm-lock.yaml": { old: lockOld, new: lockNew } },
);
save(
  "commits",
  "Unmodified diff between two actual Vue commits",
  git(["diff", "--no-ext-diff", "--no-color", "HEAD~1", "HEAD"]),
  {},
  `${source}; parent ${git(["rev-parse", "HEAD~1"]).trim()}`,
);
save(
  "github",
  "Unmodified gh pr diff 15477 --repo vuejs/core",
  readFileSync(join(root, "github-15477.patch"), "utf8"),
  {},
  "https://github.com/vuejs/core/pull/15477",
);

const edge = join(root, "edge-repo");
mkdirSync(edge, { recursive: true });
git(["init", "-q"], edge);
// Restore only files this generator created so reruns produce the same tree diff.
for (const name of ["added.txt", "renamed.txt"]) rmSync(join(edge, name), { force: true });
writeFileSync(join(edge, "before.txt"), "rename me\n");
writeFileSync(join(edge, "delete.txt"), "delete me\n");
writeFileSync(join(edge, "no-newline.txt"), "old");
writeFileSync(join(edge, "space ü.txt"), "old\n");
writeFileSync(join(edge, "binary.dat"), Buffer.from([0, 1, 2, 3]));
git(["add", "-A"], edge);
const tree1 = git(["write-tree"], edge).trim();
renameSync(join(edge, "before.txt"), join(edge, "renamed.txt"));
rmSync(join(edge, "delete.txt"));
writeFileSync(join(edge, "added.txt"), "added\n");
writeFileSync(join(edge, "no-newline.txt"), "new");
writeFileSync(join(edge, "space ü.txt"), "new\n");
writeFileSync(join(edge, "binary.dat"), Buffer.from([0, 4, 5, 6]));
git(["add", "-A"], edge);
const tree2 = git(["write-tree"], edge).trim();
save(
  "edges",
  "Git tree diff: add, delete, rename, binary, Unicode path, no final newline",
  git(["diff", "--no-color", "--find-renames", tree1, tree2], edge),
  {},
  "Isolated Git tree fixture",
);
writeFileSync(join(data, "manifest.json"), JSON.stringify(manifest, null, 2));
