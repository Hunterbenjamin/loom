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
import type { pullRequestReviewChange } from "@loom/protocol";
import type Database from "better-sqlite3";
import type { z } from "zod";
import { ArtifactStore } from "./artifacts.js";
import { BriefStore } from "./briefs.js";
import { SqliteHookLog } from "./hooks.js";
import { InputStore } from "./inputs.js";
import { LeadMessageStore } from "./lead-messages.js";
import { MainMessageStore } from "./main-messages.js";
import { Outbox } from "./outbox.js";
import { PullRequestStore } from "./pull-requests.js";
import { RepositoryStore } from "./repositories.js";
import { SettingsStore } from "./settings.js";
import { type CommitOutcome, TaskCommitStore } from "./task-commit.js";
import { TaskQueries } from "./task-queries.js";
import { TaskStateStore } from "./task-state.js";

export type { CommitOutcome, Conflict } from "./task-commit.js";

/** Public facade over stores sharing one SQLite connection. */
export class Store {
  readonly mainMessages: MainMessageStore;
  readonly briefs: BriefStore;
  readonly leadMessages: LeadMessageStore;
  readonly hooks: SqliteHookLog;
  readonly outbox: Outbox;
  readonly settings: SettingsStore;
  private readonly repositories: RepositoryStore;
  private readonly pullRequests: PullRequestStore;
  private readonly inputs: InputStore;
  private readonly queries: TaskQueries;
  private readonly state: TaskStateStore;
  private readonly commits: TaskCommitStore;
  private readonly artifacts: ArtifactStore;
  constructor(
    private readonly db: Database.Database,
    readonly dataDirectory: string,
    config: ReconcileConfig,
  ) {
    this.briefs = new BriefStore(db);
    this.mainMessages = new MainMessageStore(db);
    this.leadMessages = new LeadMessageStore(db);
    this.hooks = new SqliteHookLog(db);
    this.outbox = new Outbox(db);
    this.settings = new SettingsStore(db);
    this.artifacts = new ArtifactStore(db, dataDirectory);
    this.repositories = new RepositoryStore(db, this.settings);
    this.queries = new TaskQueries(db);
    this.pullRequests = new PullRequestStore(
      db,
      this.repositories,
      this.queries,
    );
    this.inputs = new InputStore(db, this.outbox);
    this.state = new TaskStateStore(db, this.outbox, config);
    this.commits = new TaskCommitStore(
      db,
      this.state,
      this.inputs,
      this.outbox,
      this.artifacts,
    );
  }
  /** Replace live reconcile inputs after an immediate settings update. */
  setReconcileConfig(config: ReconcileConfig): void {
    this.state.setReconcileConfig(config);
  }
  close(): void {
    this.db.close();
  }
  /** Coordinator injection for next-run defaults; captured task/run fields still win in core. */
  setRoleProfilesResolver(
    resolver: (task: Task) => ReconcileConfig["roleProfiles"],
  ): void {
    this.state.setRoleProfilesResolver(resolver);
  }
  /** Coordinator-owned per-instance project selection, persisted in the existing metadata table. */
  selectedRepo(): Repo["id"] | null {
    return this.repositories.selectedRepo();
  }
  selectRepo(id: string): void {
    this.repositories.selectRepo(id);
  }
  /** PR preferences are Loom facts; GitHub content remains a disposable projection. */
  pullRequestPreferences(
    repoId: string,
    number: number,
  ): { pinned: boolean; taskId: TaskId | null } {
    return this.pullRequests.pullRequestPreferences(repoId, number);
  }
  setPullRequestPreferences(
    repoId: string,
    number: number,
    update: { pinned?: boolean; taskId?: TaskId },
  ): void {
    this.pullRequests.setPullRequestPreferences(repoId, number, update);
  }
  /** Reverse projection of the same durable links, independent of GitHub cache/subscriptions. */
  linkedPullRequests(repoId: string, taskId: TaskId): number[] {
    return this.pullRequests.linkedPullRequests(repoId, taskId);
  }
  pullRequestViewedFiles(repoId: string, number: number, headSha: string) {
    return this.pullRequests.pullRequestViewedFiles(repoId, number, headSha);
  }
  savePullRequestReviewState(
    command: z.output<typeof pullRequestReviewChange>,
  ): void {
    this.pullRequests.savePullRequestReviewState(command);
  }
  putRepo(repo: Repo): void {
    this.repositories.putRepo(repo);
  }
  /** Legacy repository settings are read raw because Repo no longer owns these fields. */
  legacyRepoSettings(): Array<{
    repo: Repo;
    baseBranch?: string;
    defaultProviders?: Partial<
      Record<"planner" | "implementer" | "reviewer", "codex" | "claude">
    >;
    serialTests?: boolean;
  }> {
    return this.repositories.legacyRepoSettings();
  }
  /** Move legacy settings and remove their old owners as one durable operation. */
  migrateLegacySettings(
    globalUpdate: Parameters<SettingsStore["update"]>[0] | undefined,
    repositories: Array<{
      repoId: Repo["id"];
      update?: Parameters<SettingsStore["update"]>[0];
    }>,
  ): void {
    this.repositories.migrateLegacySettings(globalUpdate, repositories);
  }
  /** Inserts a new initial task. Reconcile commits are the only update path. */
  createTask(task: Omit<Task, "number">): TaskState {
    return this.state.createTask(task);
  }
  loadTaskState(taskId: TaskId): TaskState {
    return this.state.loadTaskState(taskId);
  }
  /** Full history in insertion order (newest last), including superseded runs. */
  runs(taskId: TaskId) {
    return this.queries.runs(taskId);
  }
  /**
   * Update a run's pane info (used during recovery to persist relaunched pane details).
   * Called outside of reconciliation to record pane relaunch before any pane operation.
   */
  updateRunPane(taskId: TaskId, runId: string, pane: PaneRef | null): void {
    this.queries.updateRunPane(taskId, runId, pane);
  }
  /** Full message history, including confirmed delivery and failed sends. */
  messages(taskId: TaskId) {
    return this.queries.messages(taskId);
  }
  /** The explicit loaded version is required: a fixed-point result does not increment it. */
  commit(
    taskId: TaskId,
    result: ReconcileResult,
    expectedVersion: number,
  ): CommitOutcome {
    return this.commits.commit(taskId, result, expectedVersion);
  }
  enqueueInput(taskId: TaskId, input: Input): boolean {
    return this.inputs.enqueueInput(taskId, input);
  }
  hasInput(inputId: string): boolean {
    return this.inputs.hasInput(inputId);
  }
  pendingInputs(taskId: TaskId, limit = 1): Input[] {
    return this.inputs.pendingInputs(taskId, limit);
  }
  inputDisposition(taskId: TaskId, inputId: string): InputDisposition | null {
    return this.inputs.inputDisposition(taskId, inputId);
  }
  transitions(taskId: TaskId): Transition[] {
    return this.queries.transitions(taskId);
  }
  capacityCounts(): Pick<CapacityObservation, "version" | "active"> {
    return this.inputs.capacityCounts();
  }
  dependencyStages(taskId: TaskId): DependencyObservation[] {
    return this.inputs.dependencyStages(taskId);
  }
  /** Every registered repo. The coordinator's snapshot needs the list, and nothing else owns it. */
  repos(): Repo[] {
    return this.repositories.repos();
  }
  /** Every task, newest stage changes included. Used for snapshots and the full resync. */
  tasks(): Task[] {
    return this.queries.tasks();
  }
  tasksByStage(stage: Stage): Task[] {
    return this.queries.tasksByStage(stage);
  }
  tasksNeedingAttention(): Task[] {
    return this.queries.tasksNeedingAttention();
  }
  artifact(taskId: TaskId, kind: ArtifactKind, version: number) {
    return this.artifacts.artifact(taskId, kind, version);
  }
  materializeArtifact(
    taskId: TaskId,
    kind: ArtifactKind,
    version: number,
  ): void {
    this.artifacts.materializeArtifact(taskId, kind, version);
  }
  repairArtifactFiles(): void {
    this.artifacts.repairArtifactFiles();
  }
}
