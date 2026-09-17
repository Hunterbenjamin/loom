import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestResearchName } from "@loom/core";
import { researchEntry } from "@loom/protocol";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { config } from "../test/fixtures.js";
import { openStore } from "./index.js";
import { migrate, readMigrations } from "./migrations.js";
import { ResearchStore } from "./research.js";

test("0014 retains existing documents; comments are isolated, ordered and survive reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-research-comments-"));
  const path = join(root, "store.sqlite");
  let db = new Database(path);
  try {
    await migrate(db, join(root, "backups"), readMigrations().slice(0, 13));
    const entry = researchEntry.parse({
      id: randomUUID(),
      name: "Short name",
      question: "Question",
      origin: "main",
      status: "completed",
      sessionId: null,
      provider: null,
      model: null,
      startedAt: "2026-09-16T00:00:00.000Z",
      finishedAt: "2026-09-16T00:00:00.000Z",
      archivedAt: null,
      error: null,
      document: {
        title: "Saved",
        body: "Keep this document",
        sources: [{ title: "Source", url: "https://example.org" }],
      },
    });
    let store = new ResearchStore(db);
    store.put(entry);
    const other = { ...entry, id: randomUUID() };
    store.put(other);
    await migrate(db, join(root, "backups"));
    expect(store.get(entry.id)).toEqual(entry);
    const comments = ["human", "main", "agent"].map((author) => ({
      id: randomUUID(),
      entryId: entry.id,
      author: author as "human" | "main" | "agent",
      text: author === "human" ? "@loom continue" : "Note",
      at: entry.startedAt,
      delivered: author !== "human",
    }));
    for (const comment of comments) store.appendComment(comment);
    store.appendComment({
      ...comments[0]!,
      id: randomUUID(),
      entryId: other.id,
    });
    expect(store.comments(entry.id)).toEqual(comments);
    expect(store.get(entry.id)).toEqual(entry);
    db.close();
    db = new Database(path);
    store = new ResearchStore(db);
    expect(store.comments(entry.id)).toEqual(comments);
    expect(store.getComment(comments[0]!.id)).toEqual(comments[0]);
    expect(store.getComment(randomUUID())).toBeNull();
    store.markDelivered(comments[0]!.id);
    expect(store.comments(entry.id)).toEqual(
      comments.map((c) => ({ ...c, delivered: true })),
    );
    expect(store.comments(other.id)).toHaveLength(1);
    expect(store.get(entry.id)).toEqual(entry);
    store.setArchived(other.id, "2026-09-17T00:00:00.000Z");
    expect(store.state().entries.map((row) => row.id)).toEqual([entry.id]);
    expect(store.state(true).entries.map((row) => row.id)).toEqual([other.id]);
    expect(
      store
        .state("all")
        .entries.map((row) => row.id)
        .sort(),
    ).toEqual([entry.id, other.id].sort());
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening backfills missing and null names once, including archived entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "loom-research-names-"));
  const options = { dataRoot: root, instance: "test", config };
  let store = await openStore(options);
  try {
    const entries = [undefined, null, "Keep this"].map((name, index) => ({
      id: randomUUID(),
      name,
      question: "Compare\n keyboard modes (details)",
      origin: "main",
      status: "completed",
      sessionId: null,
      provider: null,
      model: null,
      startedAt: "2026-09-16T00:00:00.000Z",
      finishedAt: "2026-09-16T00:00:00.000Z",
      archivedAt: index === 1 ? "2026-09-17T00:00:00.000Z" : null,
      error: null,
      document:
        index === 0
          ? {
              title: "A detailed\n title about keyboard modes (survey)",
              body: "Body",
              sources: [{ title: "Source", url: "https://example.org" }],
            }
          : null,
    }));
    store.close();
    const db = new Database(join(root, "test", "loom.sqlite"));
    for (const entry of entries)
      db.prepare(
        "INSERT INTO research(id,value,started_at,archived_at) VALUES (?,?,?,?)",
      ).run(entry.id, JSON.stringify(entry), entry.startedAt, entry.archivedAt);
    db.close();
    store = await openStore(options);
    for (const entry of entries) {
      const expected = researchEntry.parse({
        ...entry,
        name:
          entry.name ??
          suggestResearchName(entry.document?.title ?? entry.question),
      });
      expect(store.research.get(entry.id)).toEqual(expected);
    }
    const snapshot = store.research.list({ archived: "all" });
    store.close();
    store = await openStore(options);
    expect(store.research.list({ archived: "all" })).toEqual(snapshot);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
