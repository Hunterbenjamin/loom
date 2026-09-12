// A deterministic 50-file unified patch. Pierre parses Git patches far faster than it diffs
// full contents in the renderer (spike 04), so the fixture ships the patch, and the full
// contents only for the files a reviewer can expand.

import { between, rng } from "./rng.js";

export interface PatchFixture {
  /** A Git patch, exactly as `git diff` would print it. */
  text: string;
  /** Stable per-file metadata, taken from Git rather than from the patch text. */
  files: PatchFileMeta[];
  /** Content-derived cache key; also Pierre's revision key. */
  key: string;
  contents: Record<string, { old: string; new: string }>;
}

export interface PatchFileMeta {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  previousPath: string | null;
  added: number;
  deleted: number;
  language: string;
}

const AREAS = [
  "packages/core/src",
  "packages/store/src",
  "packages/protocol/src",
  "packages/adapters/codex/src",
  "packages/adapters/claude/src",
  "packages/adapters/herdr/src",
  "apps/coordinator/src",
];

const NAMES = [
  "reconcile",
  "stages",
  "runs",
  "findings",
  "approvals",
  "transitions",
  "worktrees",
  "sessions",
  "capacity",
  "queue",
];

function body(name: string, seed: number): string[] {
  const random = rng(seed);
  const lines: string[] = [
    `import type { Run, Task } from "@loom/core";`,
    "",
    `export interface ${name}Options {`,
    "  now: string;",
    "  strict: boolean;",
    "}",
    "",
  ];
  for (let f = 0; f < 6; f += 1) {
    lines.push(
      `export function ${name}Step${f}(task: Task, runs: Run[]): number {`,
    );
    lines.push("  let total = 0;");
    lines.push("  for (const run of runs) {");
    lines.push(
      `    if (run.status === "working") total += ${between(random, 1, 9)};`,
    );
    lines.push(`    if (run.round > ${between(random, 0, 3)}) total -= 1;`);
    lines.push("  }");
    lines.push(`  return total + task.reviewRound * ${between(random, 2, 8)};`);
    lines.push("}");
    lines.push("");
  }
  return lines;
}

/** Three hunks per file: three context lines, two deletions, three additions, three context. */
function hunks(old: string[]): {
  patch: string;
  next: string[];
  added: number;
  deleted: number;
} {
  const rows: string[] = [];
  const next = [...old];
  let drift = 0;
  let added = 0;
  let deleted = 0;
  for (let h = 0; h < 3; h += 1) {
    const start = 6 + h * 20;
    if (start + 8 > old.length) break;
    const oldStart = start + 1;
    const newStart = oldStart + drift;
    rows.push(`@@ -${oldStart},8 +${newStart},9 @@`);
    for (let i = 0; i < 3; i += 1) rows.push(` ${old[start + i]}`);
    for (let i = 3; i < 5; i += 1) rows.push(`-${old[start + i]}`);
    const replacements = [
      `    if (run.status === "blocked") total += 2;`,
      `    if (run.blockedOn === "permission") total += 3;`,
      `    if (run.endReason === "vanished") total -= 1;`,
    ];
    for (const line of replacements) rows.push(`+${line}`);
    for (let i = 5; i < 8; i += 1) rows.push(` ${old[start + i]}`);
    next.splice(start + drift + 3, 2, ...replacements);
    drift += 1;
    added += 3;
    deleted += 2;
  }
  return { patch: rows.join("\n"), next, added, deleted };
}

export function buildPatch(fileCount = 50): PatchFixture {
  const random = rng(0x10c3);
  const parts: string[] = [];
  const files: PatchFileMeta[] = [];
  const contents: Record<string, { old: string; new: string }> = {};

  for (let i = 0; i < fileCount; i += 1) {
    const area = AREAS[i % AREAS.length] as string;
    const name = NAMES[i % NAMES.length] as string;
    const path = `${area}/${name}-${Math.floor(i / NAMES.length)}.ts`;
    const old = body(name, 1000 + i);
    const { patch, next, added, deleted } = hunks(old);
    parts.push(
      `diff --git a/${path} b/${path}`,
      `index ${(0x1000000 + i).toString(16)}..${(0x2000000 + i).toString(16)} 100644`,
      `--- a/${path}`,
      `+++ b/${path}`,
      patch,
    );
    files.push({
      path,
      status: "modified",
      previousPath: null,
      added,
      deleted,
      language: "typescript",
    });
    contents[path] = {
      old: `${old.join("\n")}\n`,
      new: `${next.join("\n")}\n`,
    };
  }

  // The awkward ones a real branch always has. Pierre reports a binary change as a file with
  // no hunks, so Loom keeps the status from Git and renders its own summary (spike 04).
  const renamedFrom = "packages/core/src/legacy-stages.ts";
  const renamedTo = "packages/core/src/stage-rules.ts";
  const renamedBody = body("stageRules", 9001);
  parts.push(
    `diff --git a/${renamedFrom} b/${renamedTo}`,
    "similarity index 96%",
    `rename from ${renamedFrom}`,
    `rename to ${renamedTo}`,
    `index abc1234..def5678 100644`,
    `--- a/${renamedFrom}`,
    `+++ b/${renamedTo}`,
    hunks(renamedBody).patch,
  );
  files.push({
    path: renamedTo,
    status: "renamed",
    previousPath: renamedFrom,
    added: 9,
    deleted: 6,
    language: "typescript",
  });
  contents[renamedTo] = {
    old: `${renamedBody.join("\n")}\n`,
    new: `${hunks(renamedBody).next.join("\n")}\n`,
  };
  files.push({
    path: "docs/design/board.png",
    status: "binary",
    previousPath: null,
    added: 0,
    deleted: 0,
    language: "binary",
  });

  const text = `${parts.join("\n")}\n`;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1)
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return {
    text,
    files,
    contents,
    key: `fixture-${(hash >>> 0).toString(16)}-${random().toFixed(6)}`,
  };
}
