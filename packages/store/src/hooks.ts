import type { HookLog, HookReceipt } from "@loom/adapter-claude";
import type { IsoTime, ProviderSessionId } from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { contract, decode, encode, id, text, time } from "./schema-helpers.js";

// Keep the adapter's permissive receipt contract without importing its provider runtime.
const payloadSchema = z.looseObject({
  session_id: id,
  hook_event_name: id,
  transcript_path: text.optional(),
  cwd: text.optional(),
  prompt_id: text.optional(),
  tool_name: text.optional(),
  tool_use_id: text.optional(),
  agent_id: text.optional(),
  agent_type: text.optional(),
  prompt: text.optional(),
  source: text.optional(),
  reason: text.optional(),
  notification_type: text.optional(),
  message: text.optional(),
  error: text.optional(),
  last_assistant_message: text.nullish(),
});
const receiptSchema = contract<Omit<HookReceipt, "seq">>()(
  z.object({
    sessionId: id,
    event: id,
    promptId: text.nullable(),
    receivedAt: time,
    payload: payloadSchema,
  }),
);
const rowSchema = z.object({
  seq: z.number().int(),
  session_id: id,
  event: id,
  prompt_id: text.nullable(),
  received_at: time,
  payload: text,
});
export class SqliteHookLog implements HookLog {
  constructor(private readonly db: Database.Database) {}
  async append(receipt: Omit<HookReceipt, "seq">): Promise<HookReceipt> {
    const r = receiptSchema.parse(receipt);
    if (
      r.sessionId !== r.payload.session_id ||
      r.event !== r.payload.hook_event_name ||
      r.promptId !== (r.payload.prompt_id ?? null)
    )
      throw new Error("Hook receipt identity disagrees with payload");
    const inserted = this.db
      .prepare(
        "INSERT INTO claude_hooks(session_id, event, prompt_id, received_at, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(r.sessionId, r.event, r.promptId, r.receivedAt, encode(r.payload));
    return { ...r, seq: Number(inserted.lastInsertRowid) };
  }
  async bySession(sessionId: ProviderSessionId): Promise<HookReceipt[]> {
    return this.db
      .prepare("SELECT * FROM claude_hooks WHERE session_id = ? ORDER BY seq")
      .all(sessionId)
      .map((raw) => {
        const row = rowSchema.parse(raw);
        return {
          ...receiptSchema.parse({
            sessionId: row.session_id,
            event: row.event,
            promptId: row.prompt_id,
            receivedAt: row.received_at,
            payload: decode(payloadSchema, row.payload),
          }),
          seq: row.seq,
        };
      });
  }
  /** Retains the exact seven-day boundary. The caller supplies its clock. */
  prune(now: IsoTime): number {
    const cutoff = new Date(
      Date.parse(time.parse(now)) - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    return this.db
      .prepare(
        "DELETE FROM claude_hooks WHERE julianday(received_at) < julianday(?)",
      )
      .run(cutoff).changes;
  }
}
