import { expect, test } from "vitest";
import { command } from "./commands.js";
import {
  mentionsLoom,
  researchComment,
  researchDocument,
  researchEntry,
  researchName,
  researchSummary,
} from "./research.js";

const document = {
  title: "Answer",
  body: "First paragraph.\n\nSecond paragraph.",
  sources: [{ title: "Source", url: "https://example.org" }],
};
test("research accommodates a short answer and a survey, with bounded HTTP sources", () => {
  expect(researchDocument.parse(document)).toEqual(document);
  expect(
    researchDocument.parse({
      ...document,
      body: "A long survey.\n".repeat(5000),
    }).body.length,
  ).toBeGreaterThan(50000);
  // A local run cites files it read, so a relative path inside its directory is a source; a
  // scheme or an absolute path could name anything on the machine and is not.
  expect(
    researchDocument.parse({
      ...document,
      sources: [
        { title: "keybindings.ts", url: "packages/core/src/keybindings.ts" },
      ],
    }).sources[0]!.url,
  ).toBe("packages/core/src/keybindings.ts");
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.org",
    "/etc/passwd",
    "../outside/secrets.txt",
  ])
    expect(
      researchDocument.safeParse({
        ...document,
        sources: [{ title: "bad", url }],
      }).success,
    ).toBe(false);
  expect(
    researchDocument.safeParse({ ...document, body: "a".repeat(100001) })
      .success,
  ).toBe(false);
  expect(
    researchDocument.safeParse({ ...document, headline: "Daily" }).success,
  ).toBe(false);
});
test("entry round trips provenance and archive time", () => {
  const entry = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Short name",
    question: "Question",
    directory: null,
    pane: null,
    observedStatus: "unknown",
    origin: "main",
    status: "completed",
    sessionId: null,
    provider: null,
    model: null,
    startedAt: "2026-09-16T00:00:00.000Z",
    finishedAt: "2026-09-16T00:00:00.000Z",
    archivedAt: "2026-09-17T00:00:00.000Z",
    error: null,
    document,
  };
  expect(researchEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  const { document: doc, ...summary } = entry;
  expect(researchSummary.parse({ ...summary, title: doc.title }).name).toBe(
    entry.name,
  );
  const { name: _name, ...unnamed } = entry;
  expect(researchEntry.safeParse(unnamed).success).toBe(false);
});

test("comments validate attribution, timestamps and text bounds; mentions match anywhere without prefixes", () => {
  const comment = {
    id: "00000000-0000-4000-8000-000000000001",
    entryId: "00000000-0000-4000-8000-000000000002",
    author: "human",
    text: "x",
    at: "2026-09-16T00:00:00.000Z",
    delivered: false,
  };
  expect(researchComment.parse(comment)).toEqual(comment);
  expect(
    researchComment.safeParse({ ...comment, text: "x".repeat(16384) }).success,
  ).toBe(true);
  for (const change of [
    { text: " " },
    { text: "x".repeat(16385) },
    { author: "other" },
    { at: "today" },
  ])
    expect(researchComment.safeParse({ ...comment, ...change }).success).toBe(
      false,
    );
  for (const text of ["@loom", "Please @LoOm continue", "(@LOOM)"])
    expect(mentionsLoom(text)).toBe(true);
  for (const text of ["loom", "@loomer", "@loom2", "@loom_extra"])
    expect(mentionsLoom(text)).toBe(false);
});

test("research comments require a stable UUID request identity", () => {
  const input = {
    kind: "comment_research",
    id: "00000000-0000-4000-8000-000000000001",
    message: "Note",
  };
  expect(command.safeParse(input).success).toBe(false);
  expect(command.safeParse({ ...input, requestId: "invalid" }).success).toBe(
    false,
  );
  expect(command.safeParse({ ...input, requestId: input.id }).success).toBe(
    true,
  );
});

test("research list accepts both archive states in one request", () => {
  for (const archived of [true, false, "all"]) {
    expect(command.parse({ kind: "list_research", archived })).toEqual({
      kind: "list_research",
      archived,
    });
  }
  expect(
    command.safeParse({ kind: "list_research", archived: "archived" }).success,
  ).toBe(false);
});

test("research names are trimmed, bounded and single-line", () => {
  expect(researchName.parse("  Short  ")).toBe("Short");
  for (const name of ["", "  ", "a".repeat(33), "Two\nlines", "Two\rlines"])
    expect(researchName.safeParse(name).success).toBe(false);
});
