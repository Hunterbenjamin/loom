import { isDeepStrictEqual } from "node:util";
import type { ReconcileResult, TaskId, TaskState } from "@loom/core";
import type Database from "better-sqlite3";
import { actionSchema } from "./action-schemas.js";
import { type ArtifactStore, saveArtifacts } from "./artifacts.js";
import {
  approvalSchema,
  contextSchema,
  findingSchema,
  locationSchema,
  messageSchema,
  questionSchema,
  runSchema,
  taskSchema,
  transitionSchema,
  worktreeSchema,
} from "./entity-schemas.js";
import { dispositionSchema } from "./input-schemas.js";
import type { InputStore } from "./inputs.js";
import type { Outbox } from "./outbox.js";
import { assertSame, dataRow, encodedUpdate, upsertEntity } from "./records.js";
import { count, decode, encode } from "./schema-helpers.js";
import { type TaskStateStore, saveDependencies } from "./task-state.js";

export type Conflict = {
  ok: false;
  conflict: "task_version" | "capacity_version" | "input_consumed";
  expected?: number;
  actual?: number;
};
export type CommitOutcome =
  | Conflict
  | {
      ok: true;
      version: number;
      materializationErrors: { artifactId: string; message: string }[];
    };
class CommitConflict extends Error {
  constructor(readonly outcome: Conflict) {
    super(outcome.conflict);
  }
}
export class TaskCommitStore {
  constructor(
    private readonly db: Database.Database,
    private readonly state: TaskStateStore,
    private readonly inputs: InputStore,
    private readonly outbox: Outbox,
    private readonly artifacts: ArtifactStore,
  ) {}
  /** The explicit loaded version is required: a fixed-point result does not increment it. */
  commit(
    taskId: TaskId,
    result: ReconcileResult,
    expectedVersion: number,
  ): CommitOutcome {
    try {
      this.db
        .transaction(() => {
          const current = this.state.loadTaskState(taskId);
          if (current.task.version !== count.parse(expectedVersion))
            throw new CommitConflict({
              ok: false,
              conflict: "task_version",
              expected: expectedVersion,
              actual: current.task.version,
            });
          const nextTask = taskSchema.parse(result.next.task);
          if (nextTask.id !== taskId || nextTask.repoId !== current.task.repoId)
            throw new Error("Task identity cannot change");
          if (
            nextTask.version !== expectedVersion &&
            nextTask.version !== expectedVersion + 1
          )
            throw new Error("Invalid next task version");
          if (nextTask.version === expectedVersion) {
            if (
              !isDeepStrictEqual(result.next, current) ||
              result.actions.length ||
              result.inputs.length ||
              result.transitions.length ||
              result.capacityVersion !== undefined
            )
              throw new Error(
                "Changed reconcile result must increment task version",
              );
            return;
          }
          const raw = dataRow.parse(
            this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(taskId),
          );
          const changed = this.db
            .prepare("UPDATE tasks SET data = ? WHERE id = ? AND version = ?")
            .run(
              encodedUpdate(taskSchema, raw.data, nextTask),
              taskId,
              expectedVersion,
            );
          if (!changed.changes)
            throw new CommitConflict({
              ok: false,
              conflict: "task_version",
              expected: expectedVersion,
            });
          if (result.capacityVersion !== undefined) {
            const version = count.parse(result.capacityVersion);
            if (
              !this.db
                .prepare(
                  "UPDATE meta SET value = ? WHERE key = 'capacity_version' AND value = ?",
                )
                .run(String(version + 1), String(version)).changes
            )
              throw new CommitConflict({
                ok: false,
                conflict: "capacity_version",
                expected: version,
                actual: this.inputs.capacityCounts().version,
              });
          }
          const dispositions = result.inputs.map((v) =>
            dispositionSchema.parse(v),
          );
          const newIds = dispositions.map((v) => v.inputId);
          if (new Set(newIds).size !== newIds.length)
            throw new Error("Duplicate input dispositions");
          const consumed = new Set(current.consumedInputIds);
          for (const disposition of dispositions) {
            if (consumed.has(disposition.inputId))
              throw new CommitConflict({
                ok: false,
                conflict: "input_consumed",
              });
            if (
              !this.db
                .prepare(
                  "UPDATE inbox SET consumed_at = ?, disposition = ? WHERE id = ? AND task_id = ? AND consumed_at IS NULL",
                )
                .run(
                  nextTask.updatedAt,
                  encode(disposition),
                  disposition.inputId,
                  taskId,
                ).changes
            )
              throw new CommitConflict({
                ok: false,
                conflict: "input_consumed",
              });
            consumed.add(disposition.inputId);
          }
          assertSame(
            [...consumed].sort(),
            [...result.next.consumedInputIds].sort(),
            "Consumed IDs must match exactly the persisted dispositions",
          );
          this.saveState(result.next);
          saveDependencies(this.db, nextTask);
          for (const rawTransition of result.transitions) {
            const transition = transitionSchema.parse(rawTransition);
            if (
              transition.taskId !== taskId ||
              transition.taskVersion !== nextTask.version
            )
              throw new Error("Transition task/version disagreement");
            this.db
              .prepare(
                "INSERT INTO transitions(id, task_id, data) VALUES (?, ?, ?)",
              )
              .run(transition.id, taskId, encode(transition));
          }
          this.outbox.save(
            taskId,
            result.next.outbox,
            result.actions.map((a) => actionSchema.parse(a)),
          );
          saveArtifacts(this.db, result.next);
          // Core may omit intermediate contents when several inputs revise the same kind.
          // Never commit a live file action whose exact version cannot be recovered.
          for (const entry of result.next.outbox) {
            if (
              (entry.status === "pending" || entry.status === "running") &&
              entry.action?.kind === "write_task_files"
            ) {
              for (const ref of entry.action.artifacts) {
                if (
                  !this.db
                    .prepare(
                      "SELECT 1 FROM artifacts WHERE task_id = ? AND kind = ? AND version = ?",
                    )
                    .get(taskId, ref.kind, ref.version)
                ) {
                  throw new Error(
                    "Missing artifact version required by file action; reconcile inputs one at a time",
                  );
                }
              }
            }
          }
        })
        .immediate();
    } catch (error) {
      if (error instanceof CommitConflict) return error.outcome;
      throw error;
    }
    // Never write files on a losing CAS. If this projection fails, SQL is already durable.
    const materializationErrors: { artifactId: string; message: string }[] = [];
    for (const artifact of result.next.artifacts) {
      try {
        this.artifacts.materializeArtifact(
          taskId,
          artifact.kind,
          artifact.version,
        );
      } catch (error) {
        materializationErrors.push({
          artifactId: artifact.id,
          message:
            error instanceof Error
              ? error.message
              : "Artifact materialization failed",
        });
      }
    }
    return {
      ok: true,
      version: result.next.task.version,
      materializationErrors,
    };
  }
  private saveState(state: TaskState): void {
    const taskId = state.task.id;
    const oldContext = dataRow.parse(
      this.db
        .prepare("SELECT data FROM task_context WHERE task_id = ?")
        .get(taskId),
    );
    this.db
      .prepare(
        "UPDATE task_context SET data = ?, artifact_versions = ? WHERE task_id = ?",
      )
      .run(
        encodedUpdate(
          contextSchema,
          oldContext.data,
          contextSchema.parse(state),
        ),
        encode(state.artifacts.map(({ kind, version }) => ({ kind, version }))),
        taskId,
      );
    if (state.worktree) {
      if (
        state.worktree.taskId !== taskId ||
        state.worktree.path !== state.task.worktreePath ||
        state.worktree.repoId !== state.task.repoId
      )
        throw new Error("Worktree does not match task");
      upsertEntity(
        this.db,
        "worktrees",
        taskId,
        state.worktree.path,
        worktreeSchema,
        state.worktree,
      );
    } else if (state.task.worktreePath !== null)
      throw new Error("Missing task worktree");
    for (const run of state.runs) {
      if (run.taskId !== taskId) throw new Error("Run belongs to another task");
      upsertEntity(this.db, "runs", taskId, run.id, runSchema, run);
    }
    for (const message of state.messages) {
      if (
        !this.db
          .prepare("SELECT 1 FROM runs WHERE id = ? AND task_id = ?")
          .get(message.runId, taskId)
      )
        throw new Error("Message run belongs to another task");
      upsertEntity(
        this.db,
        "messages",
        taskId,
        message.id,
        messageSchema,
        message,
      );
    }
    for (const question of state.questions) {
      if (question.taskId !== taskId)
        throw new Error("Question belongs to another task");
      upsertEntity(
        this.db,
        "questions",
        taskId,
        question.id,
        questionSchema,
        question,
      );
    }
    for (const finding of state.findings) {
      if (finding.taskId !== taskId)
        throw new Error("Finding belongs to another task");
      const previous = this.db
        .prepare("SELECT data FROM findings WHERE id = ?")
        .get(finding.id);
      if (previous !== undefined)
        assertSame(
          decode(findingSchema, dataRow.parse(previous).data).anchor,
          finding.anchor,
          "Finding anchor is immutable",
        );
      upsertEntity(
        this.db,
        "findings",
        taskId,
        finding.id,
        findingSchema,
        finding,
      );
      if (finding.location) {
        const previousLocation = this.db
          .prepare(
            "SELECT data FROM finding_locations WHERE finding_id = ? AND version = ?",
          )
          .get(finding.id, finding.location.version);
        if (previousLocation !== undefined)
          assertSame(
            decode(locationSchema, dataRow.parse(previousLocation).data),
            finding.location,
            "Finding location version is immutable",
          );
        else
          this.db
            .prepare(
              "INSERT INTO finding_locations(finding_id, version, data) VALUES (?, ?, ?)",
            )
            .run(
              finding.id,
              finding.location.version,
              encode(locationSchema.parse(finding.location)),
            );
      }
    }
    for (const approval of state.approvals) {
      if (approval.taskId !== taskId)
        throw new Error("Approval belongs to another task");
      upsertEntity(
        this.db,
        "approvals",
        taskId,
        approval.id,
        approvalSchema,
        approval,
      );
    }
  }
}
