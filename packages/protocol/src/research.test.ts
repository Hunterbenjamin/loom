import { expect, test } from "vitest";
import { researchDocument, researchEntry } from "./research.js";

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
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.org",
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
    question: "Question",
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
});
