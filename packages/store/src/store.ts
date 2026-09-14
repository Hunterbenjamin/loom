import { isDeepStrictEqual } from "node:util";
import type {
  ArtifactKind,
  CapacityObservation,
  DependencyObservation,
  Input,
  InputDisposition,
  PaneRef,
  ReconcileConfig,
  ReconcileResult,
  Repo,
  Stage,
  Task,
  TaskId,
  TaskState,
  Transition,
} from "@loom/core";
import { pullRequestReviewChange, viewedFile } from "@loom/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";
import { actionSchema } from "./action-schemas.js";
import {
  materialize,
  readArtifact,
  readArtifactRow,
  saveArtifacts,
} from "./artifacts.js";
import {
  approvalSchema,
  contextSchema,
  findingSchema,
  locationSchema,
  messageSchema,
  questionSchema,
  repoSchema,
  runSchema,
  taskSchema,
  transitionSchema,
  worktreeSchema,
} from "./entity-schemas.js";
import { SqliteHookLog } from "./hooks.js";
import { dispositionSchema, inputSchema } from "./input-schemas.js";
import { LeadMessageStore } from "./lead-messages.js";
import { MainMessageStore } from "./main-messages.js";
import { Outbox } from "./outbox.js";
import {
  assertSame,
  dataRow,
  encodedUpdate,
  ownedRow,
  readEntities,
  upsertEntity,
} from "./records.js";
import {
  artifactKind,
  count,
  decode,
  encode,
  positive,
  text,
} from "./schema-helpers.js";
import { SettingsStore } from "./settings.js";

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
export class Store {
  private roleProfilesForTask?: (task: Task) => ReconcileConfig["roleProfiles"];
  readonly mainMessages: MainMessageStore;
  readonly leadMessages: LeadMessageStore;
  readonly hooks: SqliteHookLog;
  readonly outbox: Outbox;
  readonly settings: SettingsStore;
  constructor(
    private readonly db: Database.Database,
    readonly dataDirectory: string,
    private config: ReconcileConfig,
  ) {
    this.mainMessages = new MainMessageStore(db);
    this.leadMessages = new LeadMessageStore(db);
    this.hooks = new SqliteHookLog(db);
    this.outbox = new Outbox(db);
    this.settings = new SettingsStore(db);
  }
  /** Replace live reconcile inputs after an immediate settings update. */
  setReconcileConfig(config: ReconcileConfig): void {
    this.config = config;
  }
  close(): void {
    this.db.close();
  }
  /** Coordinator injection for next-run defaults; captured task/run fields still win in core. */
  setRoleProfilesResolver(
    resolver: (task: Task) => ReconcileConfig["roleProfiles"],
  ): void {
    this.roleProfilesForTask = resolver;
  }
  /** Coordinator-owned per-instance project selection, persisted in the existing metadata table. */
  selectedRepo(): Repo["id"] | null {
    const saved = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_opened_repo'")
      .pluck()
      .get();
    const repos = this.repos();
    return repos.find((repo) => repo.id === saved)?.id ?? repos[0]?.id ?? null;
  }
  selectRepo(id: string): void {
    if (!this.repos().some((repo) => repo.id === id))
      throw new Error("Unknown registered repository");
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES ('last_opened_repo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(id);
  }
  /** PR preferences are Loom facts; GitHub content remains a disposable projection. */
  pullRequestPreferences(
    repoId: string,
    number: number,
  ): { pinned: boolean; taskId: TaskId | null } {
    const raw = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .pluck()
      .get(`pr:${JSON.stringify([repoId, number])}`);
    return raw === undefined
      ? { pinned: false, taskId: null }
      : z
          .object({
            pinned: z.boolean(),
            taskId: z
              .string()
              .min(1)
              .transform((value) => value as TaskId)
              .nullable(),
          })
          .parse(JSON.parse(z.string().parse(raw)));
  }
  setPullRequestPreferences(
    repoId: string,
    number: number,
    update: { pinned?: boolean; taskId?: TaskId },
  ): void {
    if (!this.repos().some((repo) => repo.id === repoId))
      throw new Error("Unknown registered repository");
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Invalid pull request number");
    if (
      update.taskId &&
      !this.tasks().some(
        (task) => task.id === update.taskId && task.repoId === repoId,
      )
    )
      throw new Error("Issue must belong to the pull request repository");
    const value = { ...this.pullRequestPreferences(repoId, number), ...update };
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(`pr:${JSON.stringify([repoId, number])}`, JSON.stringify(value));
  }
  /** Reverse projection of the same durable links, independent of GitHub cache/subscriptions. */
  linkedPullRequests(repoId: string, taskId: TaskId): number[] {
    const keys = this.db
      .prepare(
        "SELECT key FROM meta WHERE key LIKE 'pr:%' AND json_extract(value, '$.taskId') = ?",
      )
      .pluck()
      .all(taskId);
    return keys
      .flatMap((key) => {
        const [repo, number] = z
          .tuple([z.string(), z.number().int().positive()])
          .parse(JSON.parse(z.string().parse(key).slice(3)));
        return repo === repoId ? [number] : [];
      })
      .sort((a, b) => a - b);
  }
  pullRequestViewedFiles(repoId: string, number: number, headSha: string) {
    const raw = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .pluck()
      .get(`pr-viewed:${JSON.stringify([repoId, number])}`);
    if (raw === undefined) return [];
    const saved = z
      .object({ headSha: z.string(), files: z.array(viewedFile) })
      .parse(JSON.parse(z.string().parse(raw)));
    return saved.headSha === headSha ? saved.files : [];
  }
  savePullRequestReviewState(
    command: z.output<typeof pullRequestReviewChange>,
  ): void {
    const { repoId, number, change } = pullRequestReviewChange.parse(command);
    if (!this.repos().some((repo) => repo.id === repoId))
      throw new Error("Unknown registered repository");
    const files = new Map(
      this.pullRequestViewedFiles(repoId, number, change.headSha).map(
        (file) => [file.fileId, file],
      ),
    );
    for (const file of change.viewed ?? []) {
      if (file.headSha !== change.headSha)
        throw new Error("Viewed file head must match review head");
      files.set(file.fileId, file);
    }
    for (const id of change.unviewed ?? []) files.delete(id);
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(
        `pr-viewed:${JSON.stringify([repoId, number])}`,
        JSON.stringify({ headSha: change.headSha, files: [...files.values()] }),
      );
  }
  putRepo(repo: Repo): void {
    const value = repoSchema.parse(repo);
    this.db
      .transaction(() => {
        const raw = this.db
          .prepare("SELECT data FROM repos WHERE id = ?")
          .get(value.id);
        this.db
          .prepare(
            "INSERT INTO repos(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
          )
          .run(
            value.id,
            encodedUpdate(
              repoSchema,
              raw === undefined ? undefined : dataRow.parse(raw).data,
              value,
            ),
          );
      })
      .immediate();
  }
  /** Inserts a new initial task. Reconcile commits are the only update path. */
  createTask(task: Task): TaskState {
    const parsed = taskSchema.parse(task);
    if (
      parsed.version !== 0 ||
      parsed.stage !== "backlog" ||
      parsed.worktreePath !== null
    )
      throw new Error(
        "New tasks must be version 0 backlog tasks without a worktree",
      );
    this.db
      .transaction(() => {
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
        this.saveDependencies(parsed);
      })
      .immediate();
    return this.loadTaskState(parsed.id);
  }
  private saveDependencies(task: Task): void {
    this.db
      .prepare("DELETE FROM task_dependencies WHERE task_id = ?")
      .run(task.id);
    for (const blockedBy of task.blockedBy)
      this.db
        .prepare(
          "INSERT INTO task_dependencies(task_id, blocked_by) VALUES (?, ?)",
        )
        .run(task.id, blockedBy);
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
  /** The explicit loaded version is required: a fixed-point result does not increment it. */
  commit(
    taskId: TaskId,
    result: ReconcileResult,
    expectedVersion: number,
  ): CommitOutcome {
    try {
      this.db
        .transaction(() => {
          const current = this.loadTaskState(taskId);
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
                actual: this.capacityCounts().version,
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
          this.saveDependencies(nextTask);
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
        this.materializeArtifact(taskId, artifact.kind, artifact.version);
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
  enqueueInput(taskId: TaskId, input: Input): boolean {
    return this.outbox.enqueueInput(taskId, input);
  }
  pendingInputs(taskId: TaskId, limit = 1): Input[] {
    positive.parse(limit);
    return this.db
      .prepare(
        "SELECT payload FROM inbox WHERE task_id = ? AND consumed_at IS NULL ORDER BY julianday(received_at), seq LIMIT ?",
      )
      .pluck()
      .all(taskId, limit)
      .map((v) => decode(inputSchema, v));
  }
  inputDisposition(taskId: TaskId, inputId: string): InputDisposition | null {
    const value = this.db
      .prepare("SELECT disposition FROM inbox WHERE task_id = ? AND id = ?")
      .pluck()
      .get(taskId, inputId);
    return value === undefined || value === null
      ? null
      : decode(dispositionSchema, value);
  }
  transitions(taskId: TaskId): Transition[] {
    return this.db
      .prepare("SELECT data FROM transitions WHERE task_id = ? ORDER BY rowid")
      .all(taskId)
      .map((r) => decode(transitionSchema, dataRow.parse(r).data));
  }
  capacityCounts(): Pick<CapacityObservation, "version" | "active"> {
    return this.db.transaction(() => {
      const version = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(
          this.db
            .prepare("SELECT value FROM meta WHERE key = 'capacity_version'")
            .pluck()
            .get(),
        );
      const active = { codex: 0, claude: 0 };
      for (const raw of this.db
        .prepare(
          "SELECT provider, COUNT(*) AS count FROM runs WHERE ended_at IS NULL AND status IN ('starting', 'working', 'blocked') AND json_extract(data, '$.origin') = 'loom' GROUP BY provider",
        )
        .all()) {
        const row = z
          .object({ provider: z.enum(["codex", "claude"]), count })
          .parse(raw);
        active[row.provider] = row.count;
      }
      return { version, active };
    })();
  }
  dependencyStages(taskId: TaskId): DependencyObservation[] {
    return this.db
      .prepare(
        "SELECT t.data FROM task_dependencies d JOIN tasks t ON t.id = d.blocked_by WHERE d.task_id = ? ORDER BY t.id",
      )
      .all(taskId)
      .map((r) => {
        const task = decode(taskSchema, dataRow.parse(r).data);
        return {
          taskId: task.id,
          stage: task.stage,
          merged: task.stage === "done",
        };
      });
  }
  /** Every registered repo. The coordinator's snapshot needs the list, and nothing else owns it. */
  repos(): Repo[] {
    return this.db
      .prepare("SELECT data FROM repos ORDER BY rowid")
      .all()
      .map((r) => decode(repoSchema, dataRow.parse(r).data));
  }
  /** Every task, newest stage changes included. Used for snapshots and the full resync. */
  tasks(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY id")
      .all()
      .map((r) => decode(taskSchema, dataRow.parse(r).data));
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
  artifact(taskId: TaskId, kind: ArtifactKind, version: number) {
    return readArtifact(this.db, taskId, kind, version);
  }
  materializeArtifact(
    taskId: TaskId,
    kind: ArtifactKind,
    version: number,
  ): void {
    materialize(this.dataDirectory, this.artifact(taskId, kind, version));
  }
  repairArtifactFiles(): void {
    for (const row of this.db
      .prepare("SELECT data, content FROM artifacts ORDER BY rowid")
      .all())
      materialize(this.dataDirectory, readArtifactRow(row));
  }
}
