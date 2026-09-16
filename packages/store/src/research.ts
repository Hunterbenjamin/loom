import {
  type ResearchComment,
  type ResearchEntry,
  type ResearchState,
  researchComment,
  researchEntry,
} from "@loom/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";

export class ResearchStore {
  constructor(private readonly db: Database.Database) {}
  comments(id: string): ResearchComment[] {
    return this.db
      .prepare(
        "SELECT value FROM research_comments WHERE entry_id=? ORDER BY sequence",
      )
      .pluck()
      .all(id)
      .map((raw) => researchComment.parse(JSON.parse(z.string().parse(raw))));
  }
  appendComment(value: ResearchComment): void {
    const comment = researchComment.parse(value);
    this.db
      .prepare(
        "INSERT INTO research_comments(id,entry_id,value) VALUES (?,?,?)",
      )
      .run(comment.id, comment.entryId, JSON.stringify(comment));
  }
  markDelivered(id: string): void {
    this.db
      .prepare(
        "UPDATE research_comments SET value=json_set(value, '$.delivered', json('true')) WHERE id=?",
      )
      .run(id);
  }
  get(id: string): ResearchEntry | null {
    const raw = this.db
      .prepare("SELECT value FROM research WHERE id=?")
      .pluck()
      .get(id);
    return raw === undefined
      ? null
      : researchEntry.parse(JSON.parse(z.string().parse(raw)));
  }
  put(value: ResearchEntry): void {
    const entry = researchEntry.parse(value);
    this.db
      .prepare(
        "INSERT INTO research(id,value,started_at,archived_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, archived_at=excluded.archived_at",
      )
      .run(entry.id, JSON.stringify(entry), entry.startedAt, entry.archivedAt);
  }
  list({
    archived = false,
  }: {
    archived?: boolean | "all";
  } = {}): ResearchEntry[] {
    return this.db
      .prepare(
        `SELECT value FROM research ${archived === "all" ? "" : `WHERE archived_at IS ${archived ? "NOT " : ""}NULL`} ORDER BY started_at DESC, id DESC`,
      )
      .pluck()
      .all()
      .map((raw) => researchEntry.parse(JSON.parse(z.string().parse(raw))));
  }
  setArchived(id: string, at: string | null): ResearchEntry {
    const entry = this.get(id);
    if (!entry) throw new Error("Unknown research entry");
    const updated = { ...entry, archivedAt: at };
    this.put(updated);
    return updated;
  }
  state(archived = false): ResearchState {
    return {
      entries: this.list({ archived }).map(({ document, ...entry }) => ({
        ...entry,
        title: document?.title ?? null,
      })),
      runningId:
        this.list({ archived: "all" }).find(
          (entry) => entry.status === "running",
        )?.id ?? null,
    };
  }
}
