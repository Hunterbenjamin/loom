import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { z } from "zod";
import { decode, encode, text } from "./schema-helpers.js";

export const dataRow = z.object({ data: text });
export const ownedRow = dataRow.extend({ task_id: text });
type EntityTable =
  | "worktrees"
  | "runs"
  | "messages"
  | "questions"
  | "findings"
  | "approvals";
// Preserve fields an older build doesn't recognize, including nested additive JSON fields.
function overlay(raw: unknown, known: unknown, next: unknown): unknown {
  if (
    !raw ||
    !known ||
    !next ||
    typeof raw !== "object" ||
    typeof known !== "object" ||
    typeof next !== "object" ||
    Array.isArray(raw) ||
    Array.isArray(known) ||
    Array.isArray(next)
  )
    return next;
  const oldRaw = raw as Record<string, unknown>;
  const oldKnown = known as Record<string, unknown>;
  const newKnown = next as Record<string, unknown>;
  const result = { ...oldRaw };
  for (const key of Object.keys(oldKnown))
    if (!(key in newKnown)) delete result[key];
  for (const [key, value] of Object.entries(newKnown))
    result[key] = overlay(oldRaw[key], oldKnown[key], value);
  return result;
}
export function encodedUpdate<T>(
  schema: z.ZodType<T>,
  previous: string | undefined,
  value: T,
): string {
  const next = schema.parse(value);
  if (previous === undefined) return encode(next);
  const raw: unknown = JSON.parse(previous);
  return encode(overlay(raw, schema.parse(raw), next));
}
export function readEntities<T>(
  db: Database.Database,
  table: EntityTable,
  taskId: string,
  schema: z.ZodType<T>,
): T[] {
  return db
    .prepare(`SELECT data FROM ${table} WHERE task_id = ? ORDER BY rowid`)
    .all(taskId)
    .map((row) => decode(schema, dataRow.parse(row).data));
}
export function upsertEntity<T>(
  db: Database.Database,
  table: EntityTable,
  taskId: string,
  key: string,
  schema: z.ZodType<T>,
  value: T,
): void {
  const previous = db
    .prepare(`SELECT task_id, data FROM ${table} WHERE id = ?`)
    .get(key);
  const row = previous === undefined ? undefined : ownedRow.parse(previous);
  if (row && row.task_id !== taskId)
    throw new Error(`Cross-task ${table} identity collision`);
  db.prepare(
    `INSERT INTO ${table}(id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
  ).run(key, taskId, encodedUpdate(schema, row?.data, value));
}
export function assertSame(a: unknown, b: unknown, message: string): void {
  if (!isDeepStrictEqual(a, b)) throw new Error(message);
}
