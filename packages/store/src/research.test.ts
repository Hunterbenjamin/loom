import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchEntry } from "@loom/protocol";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
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
    store.markDelivered(comments[0]!.id);
    expect(store.comments(entry.id)).toEqual(
      comments.map((c) => ({ ...c, delivered: true })),
    );
    expect(store.comments(other.id)).toHaveLength(1);
    expect(store.get(entry.id)).toEqual(entry);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
