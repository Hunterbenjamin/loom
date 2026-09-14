import type Database from "better-sqlite3";
import { z } from "zod";

export const leadMessage = z.strictObject({
  id: z.string().min(1),
  repoId: z.string().min(1),
  text: z.string().max(16384),
  textHash: z.string().min(1),
  state: z.enum(["queued", "sent", "delivered", "failed", "refused"]),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
});
export type LeadMessage = z.output<typeof leadMessage>;

export class LeadMessageStore {
  constructor(private readonly db: Database.Database) {}
  create(value: LeadMessage): LeadMessage {
    const row = leadMessage.parse(value);
    this.db
      .prepare(`INSERT INTO lead_messages
      (id,repo_id,text,text_hash,state,reason,created_at,sent_at,delivered_at)
      VALUES (@id,@repoId,@text,@textHash,@state,@reason,@createdAt,@sentAt,@deliveredAt)
      ON CONFLICT(repo_id,id) DO NOTHING`)
      .run(row);
    return this.get(row.repoId, row.id) ?? row;
  }
  get(repoId: string, id: string): LeadMessage | null {
    const raw = this.db
      .prepare(`SELECT id, repo_id repoId, text, text_hash textHash, state,
      reason, created_at createdAt, sent_at sentAt, delivered_at deliveredAt
      FROM lead_messages WHERE repo_id=? AND id=?`)
      .get(repoId, id);
    return raw ? leadMessage.parse(raw) : null;
  }
  list(repoId: string): LeadMessage[] {
    return z
      .array(leadMessage)
      .parse(
        this.db
          .prepare(`SELECT id, repo_id repoId, text,
      text_hash textHash, state, reason, created_at createdAt, sent_at sentAt,
      delivered_at deliveredAt FROM lead_messages WHERE repo_id=?
      ORDER BY created_at DESC LIMIT 20`)
          .all(repoId),
      )
      .reverse();
  }
  update(
    repoId: string,
    id: string,
    state: LeadMessage["state"],
    reason: string | null,
    at: string,
  ): void {
    this.db
      .prepare(`UPDATE lead_messages SET state=?, reason=?,
      sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,
      delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END
      WHERE repo_id=? AND id=?`)
      .run(state, reason, state, at, state, at, repoId, id);
  }
}
