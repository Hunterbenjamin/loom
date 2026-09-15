import type { FileChange } from "@loom/core";
import { z } from "zod";
import { blobOid, count, nulFields } from "./git.js";

const path = z.string().min(1);
const header = z
  .string()
  .regex(
    /^:[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} (?:[AMDT]|[RC][0-9]{1,3}|M[0-9]{1,3})$/,
  );
const statuses = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
} as const;
interface RawChange {
  change: FileChange;
  oldMode: string;
  newMode: string;
}
export function parseRaw(output: Buffer): RawChange[] {
  const fields = nulFields(output);
  const changes: RawChange[] = [];
  for (let i = 0; i < fields.length; ) {
    const [oldMode, newMode, oldOid, newOid, status] = header
      .parse(fields[i++])
      .slice(1)
      .split(" ");
    const kind = z.enum(["A", "M", "D", "R", "C", "T"]).parse(status?.[0]);
    const first = path.parse(fields[i++]);
    const second =
      kind === "R" || kind === "C" ? path.parse(fields[i++]) : first;
    changes.push({
      oldMode: z.string().parse(oldMode),
      newMode: z.string().parse(newMode),
      change: {
        status: statuses[kind],
        oldPath: kind === "A" ? null : first,
        newPath: kind === "D" ? null : second,
        oldBlobOid:
          oldOid === "0".repeat(40) || oldMode === "160000"
            ? null
            : blobOid.parse(oldOid),
        newBlobOid:
          newOid === "0".repeat(40) || newMode === "160000"
            ? null
            : blobOid.parse(newOid),
        binary: false,
        hunks: [],
      },
    });
  }
  return changes;
}

export function parseDirty(output: Buffer): string[] {
  const fields = nulFields(output);
  const paths = new Set<string>();
  const add = (value: unknown) => {
    const p = path.parse(value);
    if (p !== ".task" && !p.startsWith(".task/")) paths.add(p);
  };
  for (let i = 0; i < fields.length; ) {
    const record = z
      .string()
      .regex(/^[ MADRCUT?!]{2} .+$/s)
      .parse(fields[i++]);
    add(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) add(fields[i++]);
  }
  return [...paths].sort();
}

/** Binary classification is numstat metadata, including repository attributes. */
export function parseNumstat(output: Buffer) {
  const fields = nulFields(output);
  const records: { oldPath: string; newPath: string; binary: boolean }[] = [];
  for (let i = 0; i < fields.length; ) {
    const match = z
      .string()
      .parse(fields[i++])
      .match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!match) throw new Error("Invalid Git numstat record");
    const binary = match[1] === "-" && match[2] === "-";
    if (!binary) {
      count.parse(match[1]);
      count.parse(match[2]);
    }
    const oldPath = path.parse(match[3] || fields[i++]);
    const newPath = match[3] ? oldPath : path.parse(fields[i++]);
    records.push({ oldPath, newPath, binary });
  }
  return records;
}

export function parseHunks(patch: string): FileChange["hunks"] {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("@@"))
    .map((line) => {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) throw new Error("Invalid Git hunk header");
      return {
        oldStart: count.parse(match[1]),
        oldLines: count.parse(match[2] ?? "1"),
        newStart: count.parse(match[3]),
        newLines: count.parse(match[4] ?? "1"),
      };
    });
}
