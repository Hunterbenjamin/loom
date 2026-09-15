// Connects the pure reconciliation loop to owner observations, execution and wake-up hints.
import { randomUUID } from "node:crypto";
import type {
  Input,
  InputId,
  IsoTime,
  Observations,
  Provider,
  ReconcileResult,
  Repo,
  RepoId,
  TaskId,
  TaskState,
} from "@loom/core";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import type { CoordinatorViews } from "./coordinator-views.js";
import { Executor } from "./executor.js";
import type { LaunchDeps } from "./launch.js";
import type { LeadSession } from "./lead.js";
import { Loop } from "./loop.js";
import {
  capacityReading,
  observe as observeOwners,
  type PullRequestCache,
} from "./observe.js";
import type { RecipeStore } from "./recipes.js";
import type { CoordinatorSettings } from "./settings.js";
import type { Shell } from "./shell.js";
import type { WorkflowReader } from "./workflow.js";

interface CoordinatorLoopDeps {
  store: Store;
  adapters: Adapters;
  config: CoordinatorConfig;
  recipes: RecipeStore;
  settings: CoordinatorSettings;
  pullRequests: PullRequestCache;
  workflow: WorkflowReader;
  shell: Shell;
  leads: Map<string, LeadSession>;
  views(): CoordinatorViews;
  launchDeps(): LaunchDeps;
  repo(taskId: TaskId): Repo;
  repoById(repoId: RepoId): Repo;
  now(): IsoTime;
  after(ms: number, callback: () => void): () => void;
  log(message: string): void;
  reportAdapterFailure(operation: string, error: unknown): void;
}

const TERMINAL = ["done", "canceled"];
/** A pass whose owner reads take this long is logged, so slow owners show up in the log. */
const SLOW_READ_MS = 2000;

export class CoordinatorLoop {
  readonly loop: Loop;
  readonly executor: Executor;
  private readonly schedules = new Map<
    string,
    { at: string; cancel: () => void }
  >();
  private readonly cooldowns = new Map<Provider, IsoTime | null>();
  private readonly timers = new Set<() => void>();

  constructor(private readonly deps: CoordinatorLoopDeps) {
    this.loop = new Loop({
      store: this.deps.store,
      drainExecutor: () => this.executor.drain(),
      observe: (state, inputs) => this.observe(state, inputs),
      rebase: (readings, inputs) => ({
        ...readings,
        now: this.deps.now() as never,
        capacity: capacityReading(this.capacityDeps()),
        inputs,
      }),
      onCommit: ({ taskId, result }) => this.onCommit(taskId, result),
      onError: (error, taskId) => {
        this.deps.log(`Pass for ${taskId} failed: ${error.message}`);
      },
    });
    this.executor = new Executor({
      store: this.deps.store,
      adapters: this.deps.adapters,
      config: this.deps.config,
      launch: this.deps.launchDeps(),
      pullRequests: this.deps.pullRequests,
      workflow: this.deps.workflow,
      shell: this.deps.shell,
      repo: (taskId) => this.deps.repo(taskId),
      repoById: (repoId) => this.deps.repoById(repoId),
      repositorySettings: (repoId) =>
        this.deps.settings.effective(repoId).repository,
      schedule: (taskId, at, why) => this.schedule(taskId, at, why),
      notify: (level, title, body) =>
        this.deps.log(`[${level}] ${title}: ${body}`),
      now: () => this.deps.now(),
      nextInputId: () => randomUUID() as InputId,
      onResult: (taskId) => this.loop.enqueue(taskId),
      mayAct: (taskId) => this.loop.isVerified(taskId),
      onUnconfirmed: (taskId) => this.loop.enqueue(taskId),
      reportAdapterFailure: (operation, error) =>
        this.deps.reportAdapterFailure(operation, error),
    });
  }

  cancelTimers(): void {
    for (const cancel of this.timers) cancel();
    this.timers.clear();
  }

  /** Every non-terminal task gets a pass, about every 60 s (design §5.1). */
  resyncAll(): void {
    for (const task of this.deps.store.tasks())
      if (!TERMINAL.includes(task.stage)) this.loop.enqueue(task.id);
  }

  subscribeHints(): void {
    const onHint = (hint: {
      worktreePath: string | null;
      sessionId: string | null;
    }) => {
      this.deps.views().conversationViews.hint(hint.sessionId);
      if (hint.worktreePath === this.deps.store.dataDirectory) {
        void this.deps.views().publishLead();
        return;
      }
      if (!hint.worktreePath) {
        this.resyncAll();
        return;
      }
      for (const task of this.deps.store.tasks())
        if (task.worktreePath === hint.worktreePath) this.loop.enqueue(task.id);
    };
    this.timers.add(
      this.deps.adapters.paneHost.subscribe((hint) => {
        void this.deps.views().inventory.refresh();
        onHint(hint);
      }),
    );
    this.timers.add(this.deps.adapters.claude.subscribe(onHint));
  }

  schedule(taskId: TaskId, at: string, why: string): void {
    const key = `${taskId}:${why}`;
    const previous = this.schedules.get(key);
    if (previous?.at === at) return;
    if (previous) {
      previous.cancel();
      this.timers.delete(previous.cancel);
    }
    const delay = Math.max(0, Date.parse(at) - Date.parse(this.deps.now()));
    this.deps.log(`Scheduled ${why} for ${taskId} in ${delay} ms`);
    const cancel = this.deps.after(delay, () => {
      if (this.schedules.get(key)?.cancel === cancel)
        this.schedules.delete(key);
      this.timers.delete(cancel);
      this.loop.enqueue(taskId);
    });
    this.schedules.set(key, { at, cancel });
    this.timers.add(cancel);
  }

  private capacityDeps() {
    return {
      config: this.deps.config,
      capacity: { counts: () => this.deps.store.capacityCounts() },
      coolingDownUntil: () => ({
        codex: this.cooldowns.get("codex") ?? null,
        claude: this.cooldowns.get("claude") ?? null,
      }),
    };
  }

  private async observe(
    state: TaskState,
    inputs: Input[],
  ): Promise<Observations> {
    const started = performance.now();
    let times: Record<string, number> = {};
    const observations = await observeOwners(
      {
        adapters: this.deps.adapters,
        ...this.capacityDeps(),
        pullRequests: this.deps.pullRequests,
        dependencies: () => this.deps.store.dependencyStages(state.task.id),
        inputs: () => inputs,
        launchedSessions: () =>
          new Set(
            this.deps.recipes
              .all()
              .flatMap((recipe) => (recipe.sessionId ? [recipe.sessionId] : []))
              .concat(
                [...this.deps.leads.values()]
                  .map((lead) => lead.sessionId)
                  .filter(Boolean) as never[],
              ),
          ),
        refreshBase: async (s) => {
          const repo = this.deps.store
            .repos()
            .find((r) => r.id === s.task.repoId);
          if (!repo) throw new Error("Missing repository for base observation");
          await this.executor.refreshBase(
            repo.root,
            s.worktree?.baseBranch ??
              this.deps.settings.effective(repo.id).repository.baseBranch,
          );
        },
        repoOf: (s) => {
          const repo = this.deps.store
            .repos()
            .find((r) => r.id === s.task.repoId);
          return repo
            ? {
                github: repo.github,
                baseBranch: this.deps.settings.effective(repo.id).repository
                  .baseBranch,
              }
            : null;
        },
        now: () => this.deps.now(),
        reportAdapterFailure: (operation, error) =>
          this.deps.reportAdapterFailure(operation, error),
        onReadTimes: (value) => {
          times = value;
        },
      },
      state,
    );
    // A rate-limit reset the provider reports is the only source for a cooldown (design §3).
    for (const run of observations.runs) {
      if (!run.provider.ok || !run.provider.value) continue;
      const value = run.provider.value;
      if (value.provider !== "codex") continue;
      const limits = value.rateLimits;
      this.cooldowns.set(
        "codex",
        limits && limits.usageAllowed === false ? limits.resetsAt : null,
      );
    }
    observations.workflowCommands = await this.deps.workflow.read(
      this.deps.repo(state.task.id).root,
    );
    const elapsed = performance.now() - started;
    if (elapsed >= SLOW_READ_MS)
      this.deps.log(
        `Reading the owners of ${state.task.id} took ${Math.round(elapsed)} ms (${Object.entries(
          times,
        )
          .map(([owner, ms]) => `${owner} ${ms}`)
          .join(", ")})`,
      );
    return observations;
  }

  private onCommit(taskId: TaskId, result: ReconcileResult): void {
    // Stop the app-server if the task just transitioned to a terminal stage.
    const state = this.deps.store.loadTaskState(taskId);
    if (TERMINAL.includes(state.task.stage)) {
      void this.deps.adapters.stopCodexServer(taskId).catch((error) => {
        this.deps.log(
          `Warning: could not stop Codex app-server for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    this.deps.views().publishCommittedTask(taskId, result);
  }
}
