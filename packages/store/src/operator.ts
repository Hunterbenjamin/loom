// Coordinator-owned receipts. Transactions include task creation and input enqueueing.
import type Database from "better-sqlite3";
import { z } from "zod";
export const operatorEvent = z.strictObject({
  id: z.string().min(1).max(300),
  kind: z.enum([
    "attention",
    "run_ended",
    "pass_failed",
    "publish_failed",
    "stale_process",
  ]),
  at: z.string().datetime(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  message: z.string().max(8000),
  occurrence: z.string().max(8000),
  count: z.number().int().positive().default(1),
});
export type OperatorEvent = z.output<typeof operatorEvent>;
export const taskNote = z.strictObject({
  id: z.string(),
  taskId: z.string().nullable(),
  author: z.enum(["operator", "lead", "human"]),
  at: z.string().datetime(),
  eventId: z.string(),
  row: z.string(),
  outcome: z.string(),
  body: z.string().max(16000),
  forHuman: z.boolean(),
  occurrence: z.string(),
});
export type TaskNote = z.output<typeof taskNote>;
export class OperatorStore {
  constructor(private readonly db: Database.Database) {}
  atomic<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  enqueue(raw: OperatorEvent): boolean {
    const e = operatorEvent.parse(raw);
    const prior = this.event(e.id);
    if (prior) return false;
    this.db
      .prepare("INSERT INTO operator_events(id,data) VALUES (?,?)")
      .run(e.id, JSON.stringify(e));
    return true;
  }
  increment(id: string): void {
    this.atomic(() => {
      const event = this.event(id);
      if (!event) return;
      event.count++;
      this.db
        .prepare("UPDATE operator_events SET data=? WHERE id=?")
        .run(JSON.stringify(event), id);
      for (const raw of this.db
        .prepare(
          "SELECT data FROM operator_notes WHERE json_extract(data,'$.eventId')=?",
        )
        .pluck()
        .all(id)) {
        const note = taskNote.parse(JSON.parse(String(raw)));
        note.body =
          `Occurrences: ${event.count}\n${note.body.replace(/^Occurrences: \d+\n/, "")}`.slice(
            0,
            16000,
          );
        this.updateNote(note);
      }
    });
  }
  isProcessed(id: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM operator_events WHERE id=? AND processed_at IS NOT NULL",
        )
        .get(id) !== undefined
    );
  }
  queueLength(): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) FROM operator_events WHERE processed_at IS NULL",
        )
        .pluck()
        .get(),
    );
  }
  updateNote(raw: TaskNote) {
    const n = taskNote.parse(raw);
    this.db
      .prepare(
        "INSERT INTO operator_notes(id,task_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(n.id, n.taskId, JSON.stringify(n));
  }
  noteById(id: string): TaskNote | null {
    const raw = this.db
      .prepare("SELECT data FROM operator_notes WHERE id=?")
      .pluck()
      .get(id);
    return typeof raw === "string" ? taskNote.parse(JSON.parse(raw)) : null;
  }
  event(id: string): OperatorEvent | null {
    const raw = this.db
      .prepare("SELECT data FROM operator_events WHERE id=?")
      .pluck()
      .get(id);
    return typeof raw === "string"
      ? operatorEvent.parse(JSON.parse(raw))
      : null;
  }
  pending(): OperatorEvent[] {
    return this.db
      .prepare(
        "SELECT data FROM operator_events WHERE processed_at IS NULL ORDER BY rowid LIMIT 100",
      )
      .pluck()
      .all()
      .map((v) => operatorEvent.parse(JSON.parse(String(v))));
  }
  complete(id: string, at: string) {
    this.db
      .prepare("UPDATE operator_events SET processed_at=? WHERE id=?")
      .run(at, id);
  }
  note(raw: TaskNote): void {
    const n = taskNote.parse(raw);
    this.db
      .prepare(
        "INSERT INTO operator_notes(id,task_id,data) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(n.id, n.taskId, JSON.stringify(n));
  }
  notes(taskId?: string): TaskNote[] {
    const rows =
      taskId === undefined
        ? this.db
            .prepare(
              "SELECT data FROM operator_notes ORDER BY rowid DESC LIMIT 10",
            )
            .pluck()
            .all()
        : this.db
            .prepare(
              "SELECT data FROM operator_notes WHERE task_id=? ORDER BY rowid",
            )
            .pluck()
            .all(taskId);
    return rows.map((v) => taskNote.parse(JSON.parse(String(v))));
  }
  get<T>(key: string, schema: z.ZodType<T>): T | null {
    const raw = this.db
      .prepare("SELECT data FROM operator_ledger WHERE key=?")
      .pluck()
      .get(key);
    return typeof raw === "string" ? schema.parse(JSON.parse(raw)) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO operator_ledger(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  match(signature: string): string | null {
    const row = this.db
      .prepare(
        "SELECT f.task_id FROM operator_filings f JOIN tasks t ON t.id=f.task_id WHERE f.signature=? AND json_extract(t.data,'$.stage') NOT IN ('done','canceled') ORDER BY f.filed_at DESC LIMIT 1",
      )
      .pluck()
      .get(signature);
    return typeof row === "string" ? row : null;
  }
  filed(taskId: string, signature: string, at: string) {
    this.db
      .prepare(
        "INSERT INTO operator_filings(task_id,signature,filed_at) VALUES (?,?,?)",
      )
      .run(taskId, signature, at);
  }
  count(at: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) FROM operator_filings WHERE julianday(filed_at)>julianday(?)-1.0/24 AND julianday(filed_at)<=julianday(?)",
        )
        .pluck()
        .get(at, at),
    );
  }
  signature(taskId: string): string | null {
    const v = this.db
      .prepare("SELECT signature FROM operator_filings WHERE task_id=?")
      .pluck()
      .get(taskId);
    return typeof v === "string" ? v : null;
  }
}
