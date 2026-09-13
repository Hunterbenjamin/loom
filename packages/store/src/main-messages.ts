// Main message receipts and Activity notes; input enqueueing shares the transaction.
import type Database from "better-sqlite3";
import { z } from "zod";
export const taskNote = z.strictObject({
  id: z.string(),
  taskId: z.string().nullable(),
  repoId: z.string().optional(),
  author: z.enum(["main", "lead", "human"]),
  at: z.string().datetime(),
  eventId: z.string(),
  row: z.string(),
  outcome: z.string(),
  body: z.string().max(16000),
  forHuman: z.boolean(),
  occurrence: z.string(),
});
export type TaskNote = z.output<typeof taskNote>;
export class MainMessageStore {
  constructor(private readonly db: Database.Database) {}
  atomic<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  note(raw: TaskNote): void {
    const n = taskNote.parse(raw);
    this.db
      .prepare(
        "INSERT INTO main_message_notes(id,task_id,data) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(n.id, n.taskId, JSON.stringify(n));
  }
  notes(taskId?: string): TaskNote[] {
    // Offline diagnostics may inspect a database before its next additive migration.
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='main_message_notes'",
        )
        .get()
    )
      return [];
    const rows =
      taskId === undefined
        ? this.db
            .prepare(
              "SELECT data FROM main_message_notes ORDER BY rowid DESC LIMIT 10",
            )
            .pluck()
            .all()
        : this.db
            .prepare(
              "SELECT data FROM main_message_notes WHERE task_id=? ORDER BY rowid",
            )
            .pluck()
            .all(taskId);
    return rows.map((v) => taskNote.parse(JSON.parse(String(v))));
  }
  get<T>(key: string, schema: z.ZodType<T>): T | null {
    const raw = this.db
      .prepare("SELECT data FROM main_message_receipts WHERE key=?")
      .pluck()
      .get(key);
    return typeof raw === "string" ? schema.parse(JSON.parse(raw)) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO main_message_receipts(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
}
