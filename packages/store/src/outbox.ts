import type {
  Action,
  ActionKey,
  Input,
  IsoTime,
  OutboxEntry,
  TaskId,
} from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { outboxSchema } from "./action-schemas.js";
import { taskSchema } from "./entity-schemas.js";
import { inputSchema } from "./input-schemas.js";
import { assertSame, dataRow, encodedUpdate, ownedRow } from "./records.js";
import { decode, encode, text, time } from "./schema-helpers.js";

export interface ClaimedAction extends OutboxEntry {
  /** Executor lease identity, independent of core retry attempts. */
  claimVersion: number;
}
export interface RunningAction {
  taskId: TaskId;
  entry: ClaimedAction;
  startedAt: IsoTime;
}
const rowSchema = ownedRow.extend({
  key: text,
  started_at: time.nullable(),
  result_input_id: text.nullable(),
  claim_version: z.number().int().nonnegative(),
});
export class Outbox {
  constructor(private readonly db: Database.Database) {}
  /** Last ten intents plus executor receipts, even before core consumes their inbox input. */
  recent(taskId: TaskId) {
    return this.db
      .prepare(`
      SELECT o.key, o.status, o.started_at, o.executor_finished_at, i.payload
      FROM outbox o LEFT JOIN inbox i ON i.id = o.result_input_id AND i.task_id = o.task_id
      WHERE o.task_id = ? ORDER BY o.rowid DESC LIMIT 10
    `)
      .all(taskId)
      .reverse()
      .map((raw) => {
        const row = z
          .object({
            key: text,
            status: z.enum([
              "pending",
              "running",
              "succeeded",
              "failed",
              "canceled",
            ]),
            started_at: time.nullable(),
            executor_finished_at: time.nullable(),
            payload: text.nullable(),
          })
          .parse(raw);
        const input =
          row.payload === null ? null : decode(inputSchema, row.payload);
        if (input && (input.type !== "action_result" || input.key !== row.key))
          throw new Error("Outbox result identity disagreement");
        return {
          key: row.key,
          status: row.status,
          started_at: row.started_at,
          executor_finished_at: row.executor_finished_at,
          result: input?.type === "action_result" ? input.result : null,
        };
      });
  }
  list(taskId: TaskId): OutboxEntry[] {
    return this.db
      .prepare("SELECT key, data FROM outbox WHERE task_id = ? ORDER BY rowid")
      .all(taskId)
      .map((raw) => {
        const row = z.object({ key: text, data: text }).parse(raw);
        const entry = decode(outboxSchema, row.data);
        if (
          entry.key !== row.key ||
          !entry.action ||
          entry.action.taskId !== taskId ||
          entry.action.key !== row.key ||
          entry.kind !== entry.action.kind
        )
          throw new Error("Outbox intent identity disagreement");
        return entry;
      });
  }
  /** Called only inside the task's CAS transaction. Existing intent keys never insert twice. */
  save(taskId: TaskId, entries: OutboxEntry[], actions: Action[]): void {
    const keys = new Set<string>();
    for (const raw of entries) {
      const entry = outboxSchema.parse(raw);
      if (keys.has(entry.key))
        throw new Error("Duplicate outbox key in snapshot");
      keys.add(entry.key);
      if (
        !entry.action ||
        entry.action.taskId !== taskId ||
        entry.action.key !== entry.key ||
        entry.action.kind !== entry.kind
      )
        throw new Error("Outbox requires matching action payload");
      const previous = this.db
        .prepare("SELECT task_id, data FROM outbox WHERE key = ?")
        .get(entry.key);
      if (previous !== undefined) {
        const row = ownedRow.parse(previous);
        if (row.task_id !== taskId)
          throw new Error("Cross-task outbox key collision");
        const previousEntry = decode(outboxSchema, row.data);
        const replaceSchedule =
          previousEntry.action?.kind === "schedule" &&
          entry.action.kind === "schedule" &&
          previousEntry.action.taskId === entry.action.taskId &&
          previousEntry.action.why === entry.action.why &&
          entry.status === "pending";
        if (!replaceSchedule)
          assertSame(
            previousEntry.action,
            entry.action,
            "Outbox action intent is immutable",
          );
        this.db
          .prepare(
            replaceSchedule
              ? "UPDATE outbox SET data = ?, started_at = NULL, executor_finished_at = NULL, result_input_id = NULL WHERE key = ?"
              : "UPDATE outbox SET data = ? WHERE key = ?",
          )
          .run(encodedUpdate(outboxSchema, row.data, entry), entry.key);
      } else {
        this.db
          .prepare(
            "INSERT INTO outbox(key, task_id, data) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
          )
          .run(entry.key, taskId, encode(entry));
      }
    }
    for (const action of actions) {
      const entry = entries.find((row) => row.key === action.key);
      if (!entry) throw new Error("Emitted action missing from next outbox");
      assertSame(
        action,
        entry.action,
        `Emitted action disagrees with outbox for key: ${action.key}`,
      );
    }
    for (const entry of entries)
      for (const dependency of entry.dependsOn ?? []) {
        if (
          dependency === entry.key ||
          !this.db
            .prepare("SELECT 1 FROM outbox WHERE key = ? AND task_id = ?")
            .get(dependency, taskId)
        )
          throw new Error(
            "Outbox dependency must reference another intent in this task",
          );
      }
  }
  enqueueInput(taskId: TaskId, raw: Input): boolean {
    const input = inputSchema.parse(raw);
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare("SELECT task_id, payload FROM inbox WHERE id = ?")
          .get(input.id);
        if (previous !== undefined) {
          const row = z
            .object({ task_id: text, payload: text })
            .parse(previous);
          if (row.task_id !== taskId)
            throw new Error("Cross-task input identity collision");
          assertSame(
            decode(inputSchema, row.payload),
            input,
            "Input identity reused with different payload",
          );
          return false;
        }
        this.db
          .prepare(
            "INSERT INTO inbox(id, task_id, received_at, payload) VALUES (?, ?, ?, ?)",
          )
          .run(input.id, taskId, input.receivedAt, encode(input));
        return true;
      })
      .immediate();
  }
  private touchTask(taskId: string): void {
    // Claims/results race with reconcile, so invalidate any previously loaded task snapshot.
    const raw = dataRow.parse(
      this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(taskId),
    );
    const task = decode(taskSchema, raw.data);
    this.db.prepare("UPDATE tasks SET data = ? WHERE id = ?").run(
      encodedUpdate(taskSchema, raw.data, {
        ...task,
        version: task.version + 1,
      }),
      taskId,
    );
  }
  claim(now: IsoTime, taskId?: TaskId): ClaimedAction | null {
    time.parse(now);
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            "SELECT * FROM outbox WHERE status = 'pending' AND result_input_id IS NULL AND (? IS NULL OR task_id = ?) ORDER BY rowid",
          )
          .all(taskId ?? null, taskId ?? null);
        for (const raw of rows) {
          const row = rowSchema.parse(raw);
          const entry = decode(outboxSchema, row.data);
          if (entry.retryAt && Date.parse(entry.retryAt) > Date.parse(now))
            continue;
          if (
            (entry.dependsOn ?? []).some(
              (key) =>
                this.db
                  .prepare(
                    "SELECT status FROM outbox WHERE key = ? AND task_id = ?",
                  )
                  .pluck()
                  .get(key, row.task_id) !== "succeeded",
            )
          )
            continue;
          const claimed: OutboxEntry = {
            ...entry,
            status: "running",
            attempts: Math.max(1, entry.attempts),
          };
          this.db
            .prepare(
              "UPDATE outbox SET data = ?, started_at = ?, executor_finished_at = NULL, claim_version = claim_version + 1 WHERE key = ?",
            )
            .run(encodedUpdate(outboxSchema, row.data, claimed), now, row.key);
          this.touchTask(row.task_id);
          return { ...claimed, claimVersion: row.claim_version + 1 };
        }
        return null;
      })
      .immediate();
  }
  /** Recheck immediately before external side effects; cancellation can race an already running action. */
  isClaimCurrent(key: ActionKey, claimVersion: number): boolean {
    const raw = this.db.prepare("SELECT * FROM outbox WHERE key = ?").get(key);
    if (!raw) return false;
    const row = rowSchema.parse(raw),
      entry = decode(outboxSchema, row.data);
    return (
      entry.status === "running" &&
      row.claim_version === claimVersion &&
      row.result_input_id === null
    );
  }
  /**
   * Persist the executor receipt and inbox input atomically. Core must still apply the result:
   * do NOT set OutboxEntry.finishedAt/status until that reconcile commits (core skips finished rows).
   */
  finish(
    key: ActionKey,
    claimVersion: number,
    raw: Extract<Input, { type: "action_result" }>,
  ): boolean {
    const input = inputSchema.parse(raw);
    if (input.type !== "action_result" || input.key !== key)
      throw new Error("Expected a matching action-result input");
    return this.db
      .transaction(() => {
        const rawRow = this.db
          .prepare("SELECT * FROM outbox WHERE key = ?")
          .get(key);
        if (!rawRow) return false;
        const row = rowSchema.parse(rawRow),
          entry = decode(outboxSchema, row.data);
        if (entry.kind !== input.result.kind)
          throw new Error("Action result kind disagrees with intent");
        if (
          entry.status !== "running" ||
          row.claim_version !== claimVersion ||
          row.result_input_id !== null
        )
          return false;
        this.enqueueInput(row.task_id as TaskId, input);
        this.db
          .prepare(
            "UPDATE outbox SET result_input_id = ?, executor_finished_at = ? WHERE key = ?",
          )
          .run(input.id, input.receivedAt, key);
        this.touchTask(row.task_id);
        return true;
      })
      .immediate();
  }
  /** Reports uncertain execution only; never automatically retries external effects. */
  runningAtStartup(): RunningAction[] {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE status = 'running' AND result_input_id IS NULL ORDER BY rowid",
      )
      .all()
      .map((raw) => {
        const row = rowSchema.parse(raw);
        return {
          taskId: row.task_id as TaskId,
          entry: {
            ...decode(outboxSchema, row.data),
            claimVersion: row.claim_version,
          },
          startedAt: time.parse(row.started_at) as IsoTime,
        };
      });
  }
  /** Coordinator calls only after reconciling the external owner and deciding retry is safe. */
  requeue(key: ActionKey, claimVersion: number): boolean {
    return this.db
      .transaction(() => {
        if (!this.isClaimCurrent(key, claimVersion)) return false;
        const row = rowSchema.parse(
          this.db.prepare("SELECT * FROM outbox WHERE key = ?").get(key),
        );
        const entry = decode(outboxSchema, row.data);
        this.db
          .prepare(
            "UPDATE outbox SET data = ?, started_at = NULL WHERE key = ?",
          )
          .run(
            encodedUpdate(outboxSchema, row.data, {
              ...entry,
              status: "pending",
            }),
            key,
          );
        this.touchTask(row.task_id);
        return true;
      })
      .immediate();
  }
}
