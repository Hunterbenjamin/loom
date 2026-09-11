// Conservative, single-line spike prototype. Persisted production anchors also need
// immutable commit/blob identities and selected/context hashes (see FINDINGS.md).
export type Anchor = { line: number; text: string; before: string[]; after: string[] };
export function capture(lines: string[], line: number): Anchor {
  if (line < 1 || line > lines.length) throw new Error("Anchor outside file");
  return {
    line,
    text: lines[line - 1],
    before: lines.slice(Math.max(0, line - 3), line - 1),
    after: lines.slice(line, line + 2),
  };
}
export function relocate(
  anchor: Anchor,
  lines: string[],
): { status: "exact" | "moved"; line: number } | { status: "outdated" | "ambiguous" } {
  if (!anchor.text.trim()) return { status: "ambiguous" };
  const matches = lines.flatMap((text, index) => (text === anchor.text ? [index] : []));
  const contextual = matches.filter(
    (index) =>
      JSON.stringify(lines.slice(Math.max(0, index - anchor.before.length), index)) ===
        JSON.stringify(anchor.before) &&
      JSON.stringify(lines.slice(index + 1, index + 1 + anchor.after.length)) ===
        JSON.stringify(anchor.after),
  );
  const candidates = contextual.length ? contextual : matches;
  if (!candidates.length) return { status: "outdated" };
  if (candidates.length !== 1) return { status: "ambiguous" };
  const line = candidates[0] + 1;
  return { status: line === anchor.line ? "exact" : "moved", line };
}
