import type { PaneRef, Stage, Task, TaskId, Transition } from "@loom/core";
import type Database from "better-sqlite3";
import {
  messageSchema,
  runSchema,
  taskSchema,
  transitionSchema,
} from "./entity-schemas.js";
import { dataRow, ownedRow, readEntities, upsertEntity } from "./records.js";
import { decode, text } from "./schema-helpers.js";

export class TaskQueries {
  constructor(private readonly db: Database.Database) {}
  /** Full history in insertion order (newest last), including superseded runs. */
  runs(taskId: TaskId) {
    return readEntities(this.db, "runs", taskId, runSchema);
  }
  /**
   * Update a run's pane info (used during recovery to persist relaunched pane details).
   * Called outside of reconciliation to record pane relaunch before any pane operation.
   */
  updateRunPane(taskId: TaskId, runId: string, pane: PaneRef | null): void {
    const raw = this.db
      .prepare("SELECT task_id, data FROM runs WHERE id = ?")
      .get(runId);
    if (!raw) throw new Error(`Run ${runId} not found`);
    const row = ownedRow.parse(raw);
    if (row.task_id !== taskId) throw new Error(`Run belongs to another task`);
    const run = decode(runSchema, row.data);
    upsertEntity(this.db, "runs", taskId, runId, runSchema, { ...run, pane });
  }
  /** Full message history, including confirmed delivery and failed sends. */
  messages(taskId: TaskId) {
    return readEntities(this.db, "messages", taskId, messageSchema);
  }
  transitions(taskId: TaskId): Transition[] {
    return this.db
      .prepare("SELECT data FROM transitions WHERE task_id = ? ORDER BY rowid")
      .all(taskId)
      .map((r) => decode(transitionSchema, dataRow.parse(r).data));
  }
  /** Every task, newest stage changes included. Used for snapshots and the full resync. */
  tasks(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY id")
      .all()
      .map((r) => decode(taskSchema, dataRow.parse(r).data));
  }
  /** Tasks whose worktree, and with it their pane workspace, has not been removed. */
  liveWorktreeTaskIds(): TaskId[] {
    return this.db
      .prepare(
        "SELECT task_id FROM worktrees WHERE json_extract(data, '$.removedAt') IS NULL ORDER BY task_id",
      )
      .pluck()
      .all()
      .map((v) => text.parse(v) as TaskId);
  }
  tasksByStage(stage: Stage): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks WHERE stage = ? ORDER BY id")
      .all(stage)
      .map((r) => decode(taskSchema, dataRow.parse(r).data));
  }
  tasksNeedingAttention(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks WHERE needs_attention = 1 ORDER BY id")
      .all()
      .map((r) => decode(taskSchema, dataRow.parse(r).data));
  }
}
