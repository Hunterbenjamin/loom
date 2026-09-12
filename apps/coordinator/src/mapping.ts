// `map_findings`: where an immutable anchor points on a later head (architecture, "Finding
// anchors"). Git supplies the hunks and the renames; the arithmetic here is pure.
//
// Two rules from the design that this must not break: a finding is never resolved because its
// line disappeared, and the nearest duplicate is never silently picked. A line inside a changed
// hunk is `ambiguous`, a deleted file is `outdated`, and both keep the finding open.

import type { FileChange, Finding, FindingLocation, Sha } from "@loom/core";

export interface MappedRange {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  status: FindingLocation["status"];
}

/** One file's change between two heads, keyed by the path the anchor knows. */
export type ChangeIndex = Map<string, FileChange>;

export function indexChanges(changes: readonly FileChange[]): ChangeIndex {
  const index: ChangeIndex = new Map();
  for (const change of changes)
    if (change.oldPath) index.set(change.oldPath, change);
  return index;
}

/**
 * Maps one line range forward through a file's hunks. Lines before every change keep their
 * number; lines after shift by the accumulated delta; a line that a hunk rewrote is ambiguous.
 */
export function mapRange(
  change: FileChange | undefined,
  startLine: number,
  endLine: number,
): MappedRange {
  if (!change) return { path: null, startLine, endLine, status: "exact" };
  if (change.status === "deleted")
    return { path: null, startLine: null, endLine: null, status: "outdated" };
  const path = change.newPath ?? change.oldPath;
  if (change.binary)
    return { path, startLine: null, endLine: null, status: "ambiguous" };
  let delta = 0;
  for (const hunk of change.hunks) {
    const hunkEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;
    if (hunkEnd < startLine) {
      delta += hunk.newLines - hunk.oldLines;
      continue;
    }
    // The hunk starts at or before the range's end: the anchored text was rewritten.
    if (hunk.oldStart <= endLine)
      return { path, startLine: null, endLine: null, status: "ambiguous" };
    break;
  }
  return {
    path,
    startLine: startLine + delta,
    endLine: endLine + delta,
    status: delta === 0 && change.status !== "renamed" ? "exact" : "moved",
  };
}

export interface MapFindingsInput {
  findings: readonly Finding[];
  findingIds: readonly string[];
  toHeadSha: Sha;
  /** Changes between each anchor's head and `toHeadSha`, already read from git. */
  changes: ChangeIndex;
  mappedAt: string;
}

/** A new `FindingLocation` version per finding. Findings without an anchor are task-level. */
export function mapFindings(
  input: MapFindingsInput,
): { findingId: Finding["id"]; location: FindingLocation }[] {
  const wanted = new Set(input.findingIds);
  const mapped: { findingId: Finding["id"]; location: FindingLocation }[] = [];
  for (const finding of input.findings) {
    if (!wanted.has(finding.id)) continue;
    const anchor = finding.anchor;
    if (!anchor) continue;
    const version = (finding.location?.version ?? 0) + 1;
    if (finding.location?.headSha === input.toHeadSha) continue;
    const anchoredPath =
      anchor.side === "new" ? anchor.newPath : anchor.oldPath;
    if (!anchoredPath) continue;
    // An `old`-side anchor points into a blob the branch has moved past; once the file changes
    // again there is nothing honest to map it onto, so it is marked outdated rather than guessed.
    const change = input.changes.get(anchoredPath);
    const range =
      anchor.side === "new"
        ? mapRange(change, anchor.startLine, anchor.endLine)
        : {
            path: anchoredPath,
            startLine: change ? null : anchor.startLine,
            endLine: change ? null : anchor.endLine,
            status: (change
              ? "outdated"
              : "exact") as FindingLocation["status"],
          };
    mapped.push({
      findingId: finding.id,
      location: {
        headSha: input.toHeadSha,
        path: range.path ?? anchoredPath,
        blobOid:
          change?.newBlobOid ??
          (change
            ? null
            : anchor.side === "new"
              ? anchor.newBlobOid
              : anchor.oldBlobOid),
        side: anchor.side,
        startLine: range.startLine,
        endLine: range.endLine,
        status: range.status,
        version,
        mappedAt: input.mappedAt as FindingLocation["mappedAt"],
      },
    });
  }
  return mapped;
}
