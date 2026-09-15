import type { ReconcileConfig, Task, TaskId, TaskState } from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";
import { readArtifactRow } from "./artifacts.js";
import {
  approvalSchema,
  contextSchema,
  findingSchema,
  messageSchema,
  questionSchema,
  runSchema,
  taskSchema,
  worktreeSchema,
} from "./entity-schemas.js";
import { dispositionSchema } from "./input-schemas.js";
import type { Outbox } from "./outbox.js";
import { assertSame, dataRow, ownedRow, readEntities } from "./records.js";
import {
  artifactKind,
  decode,
  encode,
  positive,
  text,
} from "./schema-helpers.js";

export class TaskStateStore {
  private roleProfilesForTask?: (task: Task) => ReconcileConfig["roleProfiles"];
  constructor(
    private readonly db: Database.Database,
    private readonly outbox: Outbox,
    private config: ReconcileConfig,
  ) {}
  /** Replace live reconcile inputs after an immediate settings update. */
  setReconcileConfig(config: ReconcileConfig): void {
    this.config = config;
  }
  /** Coordinator injection for next-run defaults; captured task/run fields still win in core. */
  setRoleProfilesResolver(
    resolver: (task: Task) => ReconcileConfig["roleProfiles"],
  ): void {
    this.roleProfilesForTask = resolver;
  }
  /** Inserts a new initial task. Reconcile commits are the only update path. */
  createTask(task: Omit<Task, "number">): TaskState {
    const validated = taskSchema.parse({ ...task, number: 1 });
    const { number: _ignoredNumber, ...input } = validated;
    if (
      input.version !== 0 ||
      input.stage !== "backlog" ||
      input.worktreePath !== null
    )
      throw new Error(
        "New tasks must be version 0 backlog tasks without a worktree",
      );
    const taskId = input.id;
    this.db
      .transaction(() => {
        const number = this.db
          .prepare(
            "SELECT COALESCE(MAX(json_extract(data, '$.number')), 0) + 1 FROM tasks WHERE repo_id = ?",
          )
          .pluck()
          .get(input.repoId) as number;
        const parsed = taskSchema.parse({ ...input, number });
        this.db
          .prepare("INSERT INTO tasks(id, repo_id, data) VALUES (?, ?, ?)")
          .run(parsed.id, parsed.repoId, encode(parsed));
        this.db
          .prepare("INSERT INTO task_context(task_id, data) VALUES (?, ?)")
          .run(
            parsed.id,
            encode({
              plan: null,
              review: null,
              desiredRun: null,
              progress: null,
              activeElapsedMs: 0,
              budgetObservedAt: parsed.createdAt,
            }),
          );
        saveDependencies(this.db, parsed);
      })
      .immediate();
    return this.loadTaskState(taskId);
  }
  loadTaskState(taskId: TaskId): TaskState {
    return this.db.transaction(() => {
      const task = this.readTask(taskId);
      const contextRow = dataRow
        .extend({ artifact_versions: text })
        .parse(
          this.db
            .prepare(
              "SELECT data, artifact_versions FROM task_context WHERE task_id = ?",
            )
            .get(taskId),
        );
      const context = decode(contextSchema, contextRow.data);
      const versions = decode(
        z.array(z.object({ kind: artifactKind, version: positive })),
        contextRow.artifact_versions,
      );
      const worktree =
        task.worktreePath === null
          ? null
          : decode(
              worktreeSchema,
              ownedRow.parse(
                this.db
                  .prepare(
                    "SELECT task_id, data FROM worktrees WHERE id = ? AND task_id = ?",
                  )
                  .get(task.worktreePath, taskId),
              ).data,
            );
      if (
        worktree &&
        (worktree.taskId !== taskId ||
          worktree.path !== task.worktreePath ||
          worktree.repoId !== task.repoId)
      )
        throw new Error("Task worktree reference disagreement");
      const allRuns = readEntities(this.db, "runs", taskId, runSchema);
      const latestEnded = new Map<string, (typeof allRuns)[number]>();
      for (const run of allRuns) {
        const previous = latestEnded.get(run.role);
        if (
          run.endedAt &&
          (!previous?.endedAt ||
            Date.parse(run.endedAt) >= Date.parse(previous.endedAt))
        )
          latestEnded.set(run.role, run);
      }
      const runs = allRuns.filter(
        (r) => r.endedAt === null || latestEnded.get(r.role)?.id === r.id,
      );
      const artifactRows = this.db
        .prepare(
          "SELECT a.data, a.content FROM artifacts a WHERE a.task_id = ? AND a.version = (SELECT MAX(b.version) FROM artifacts b WHERE b.task_id = a.task_id AND b.kind = a.kind) ORDER BY a.rowid",
        )
        .all(taskId)
        .map(readArtifactRow);
      const artifacts = artifactRows.map((r) => r.artifact);
      assertSame(
        versions.map((v) => `${v.kind}@${v.version}`).sort(),
        artifacts.map((a) => `${a.kind}@${a.version}`).sort(),
        "Artifact manifest/version disagreement",
      );
      const artifactContents = Object.fromEntries(
        artifactRows.map((r) => [r.artifact.kind, r.content]),
      );
      const consumedInputIds = this.db
        .prepare(
          "SELECT disposition FROM inbox WHERE task_id = ? AND consumed_at IS NOT NULL ORDER BY seq",
        )
        .pluck()
        .all(taskId)
        .map((raw) => decode(dispositionSchema, raw).inputId);
      const dependencies = this.db
        .prepare(
          "SELECT blocked_by FROM task_dependencies WHERE task_id = ? ORDER BY blocked_by",
        )
        .pluck()
        .all(taskId)
        .map((v) => text.parse(v));
      assertSame(
        dependencies,
        [...task.blockedBy].sort(),
        "Dependency rows disagree with task",
      );
      return {
        task,
        worktree,
        runs,
        messages: readEntities(
          this.db,
          "messages",
          taskId,
          messageSchema,
        ).filter((m) => m.status === "pending" || m.status === "sent"),
        questions: readEntities(
          this.db,
          "questions",
          taskId,
          questionSchema,
        ).filter((q) => q.answeredAt === null),
        findings: readEntities(this.db, "findings", taskId, findingSchema),
        approvals: readEntities(
          this.db,
          "approvals",
          taskId,
          approvalSchema,
        ).filter((a) => a.voidedAt === null),
        artifacts,
        artifactContents,
        consumedInputIds,
        outbox: this.outbox.list(taskId),
        config: this.roleProfilesForTask
          ? { ...this.config, roleProfiles: this.roleProfilesForTask(task) }
          : this.config,
        ...context,
      };
    })();
  }
  private readTask(taskId: TaskId): Task {
    const value = decode(
      taskSchema,
      dataRow.parse(
        this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(taskId),
      ).data,
    );
    if (value.id !== taskId) throw new Error("Task identity disagreement");
    return value;
  }
}

/** Shared by initial task creation and the reconcile transaction. */
export function saveDependencies(db: Database.Database, task: Task): void {
  db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(task.id);
  for (const blockedBy of task.blockedBy)
    db.prepare(
      "INSERT INTO task_dependencies(task_id, blocked_by) VALUES (?, ?)",
    ).run(task.id, blockedBy);
}
