// The coordinator: one long-running process per instance. It owns the loop, the executor, the MCP
// server agents call, and the protocol server windows connect to. Everything it talks to is
// injected, so a test can run the whole thing against `@loom/fake-agent` and a temporary store.

import { randomUUID } from "node:crypto";
import type {
  Attention,
  HumanCommand,
  Input,
  InputId,
  IsoTime,
  Observations,
  Provider,
  ProviderRules,
  ReconcileResult,
  Repo,
  RepoId,
  RunId,
  Task,
  TaskId,
  TaskState,
} from "@loom/core";
import { leadCommand, serveHttp } from "@loom/mcp";
import type { Change, Subscription } from "@loom/protocol";
import { command as commandSchema } from "@loom/protocol";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import {
  COORDINATOR_VERSION,
  type CoordinatorConfig,
  epochOf,
} from "./config.js";
import { Executor } from "./executor.js";
import { inspectTask } from "./inspect.js";
import type { LaunchDeps } from "./launch.js";
import { LeadSession } from "./lead.js";
import { Loop } from "./loop.js";
import { createMcpHost } from "./mcp-host.js";
import { observe as observeOwners, PullRequestCache } from "./observe.js";
import { RecipeStore } from "./recipes.js";
import { type RecoveryReport, recover } from "./recovery.js";
import { ProtocolServer } from "./server.js";
import {
  changesRow,
  PublishedRows,
  type Row,
  taskRows,
  type ViewDeps,
} from "./views.js";
import { createWorkflowReader } from "./workflow.js";

const TERMINAL = ["done", "canceled"];
const EMPTY_ATTENTION: Attention = {
  reasons: [],
  reasonSince: {},
  since: null,
};

export interface CoordinatorOptions {
  config: CoordinatorConfig;
  store: Store;
  adapters: Adapters;
  /** Injected in tests so nothing depends on the wall clock. */
  now?: () => IsoTime;
  /** Injected in tests: a fake clock's `after`, so a schedule never waits in real time. */
  after?: (ms: number, callback: () => void) => () => void;
  log?: (message: string) => void;
  /** Skip the protocol listener (the CLI's one-shot commands do not need it). */
  serveProtocol?: boolean;
}

export interface CreateTaskInput {
  repoId: RepoId;
  title: string;
  description: string;
  providers?: ProviderRules | null;
  requirePlanApproval?: boolean | null;
  blockedBy?: TaskId[];
  budgetMinutes?: number | null;
}

export class Coordinator {
  readonly config: CoordinatorConfig;
  readonly store: Store;
  readonly adapters: Adapters;
  readonly recipes: RecipeStore;
  readonly lead: LeadSession;
  private leadPoll: NodeJS.Timeout | null = null;
  private pollingLead = false;
  readonly loop: Loop;
  readonly executor: Executor;
  readonly protocol: ProtocolServer;
  readonly startedAt: IsoTime;
  readonly epoch: string;

  private readonly published = new PublishedRows();
  private readonly pullRequests = new PullRequestCache();
  private readonly cooldowns = new Map<Provider, IsoTime | null>();
  private readonly timers = new Set<() => void>();
  private readonly diffScopes = new Set<string>();
  private readonly publishFailures = new Map<TaskId, Set<string>>();
  private readonly workflow = createWorkflowReader((message) =>
    this.log(message),
  );
  private readonly now: () => IsoTime;
  private readonly after: (ms: number, callback: () => void) => () => void;
  private readonly logger: (message: string) => void;
  // Built on first use: the fields it closes over are assigned in the constructor body.
  private mcpCache: ReturnType<Coordinator["mcpMiddleware"]> | null = null;
  private mcp: Awaited<ReturnType<typeof serveHttp>> | null = null;
  private pump: NodeJS.Timeout | null = null;
  private resync: NodeJS.Timeout | null = null;

  constructor(private readonly options: CoordinatorOptions) {
    this.config = options.config;
    this.store = options.store;
    this.adapters = options.adapters;
    this.now = options.now ?? (() => new Date().toISOString() as IsoTime);
    this.after =
      options.after ??
      ((ms, callback) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.logger = options.log ?? (() => {});
    this.startedAt = this.now();
    this.epoch = epochOf(this.startedAt);
    this.recipes = new RecipeStore(this.store.dataDirectory);
    this.lead = new LeadSession({
      adapters: this.adapters,
      config: this.config,
      dataDirectory: this.store.dataDirectory,
      mcpEntry: (token) => this.launchDeps().mcpEntry(token),
      now: () => this.now(),
    });

    this.loop = new Loop({
      store: this.store,
      drainExecutor: () => this.executor.drain(),
      observe: (state, inputs) => this.observe(state, inputs),
      onCommit: ({ taskId, result }) => this.onCommit(taskId, result),
      onError: (error, taskId) =>
        this.log(`Pass for ${taskId} failed: ${error.message}`),
    });
    this.executor = new Executor({
      store: this.store,
      adapters: this.adapters,
      config: this.config,
      launch: this.launchDeps(),
      pullRequests: this.pullRequests,
      repo: (taskId) => this.repo(taskId),
      repoById: (repoId) => this.repoById(repoId),
      schedule: (taskId, at, why) => this.schedule(taskId, at, why),
      notify: (level, title, body) => this.log(`[${level}] ${title}: ${body}`),
      now: () => this.now(),
      nextInputId: () => randomUUID() as InputId,
      onResult: (taskId) => this.loop.enqueue(taskId),
    });
    this.protocol = new ProtocolServer({
      token: this.config.token,
      instance: this.config.instance,
      version: COORDINATOR_VERSION,
      startedAt: this.startedAt,
      epoch: this.epoch,
      heartbeatMs: this.config.heartbeatMs,
      bind: this.config.bind,
      now: () => this.now(),
      snapshot: async (scope) => {
        await this.refreshAll(scope);
        return this.published.rows();
      },
      command: (value) => this.command(value),
      ensure: (scope) => this.ensure(scope),
      onError: (error) => this.log(`Protocol error: ${error.message}`),
    });
  }

  log(message: string): void {
    this.logger(message);
  }

  /** A run's MCP token, resolved against current run state. Null means an unknown token. */
  resolveRunToken(token: string): { runId: RunId; active: boolean } | null {
    const identity = this.mcpOptions().resolveToken(token);
    return identity && "runId" in identity ? identity : null;
  }

  /** The MCP endpoint agents reach, as their per-run config records it. */
  get mcpUrl(): URL | null {
    return this.mcp?.url ?? null;
  }

  async start(): Promise<RecoveryReport> {
    await this.recipes.load();
    await this.lead.load();
    // Stable instance configuration wins; only ephemeral instances reuse the Lead recipe's port.
    const mcpPort = this.config.mcpPort || this.lead.mcpPort;
    try {
      this.mcp = await serveHttp(this.mcpOptions(), mcpPort);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("EADDRINUSE") || message.includes("in use")) {
        throw new Error(
          `Port ${mcpPort} is in use; set LOOM_MCP_PORT to a different value`,
        );
      }
      throw error;
    }
    await this.lead.recover();
    const report = await recover(
      {
        store: this.store,
        adapters: this.adapters,
        recipes: this.recipes,
        launch: this.launchDeps(),
        repo: (taskId) => this.repo(taskId),
        now: () => this.now(),
        nextInputId: () => randomUUID() as InputId,
        log: (message) => this.log(message),
      },
      this.store.outbox.runningAtStartup(),
    );
    for (const taskId of report.reconciled) this.loop.enqueue(taskId);
    this.subscribeHints();
    if (this.options.serveProtocol !== false) await this.protocol.start();
    return report;
  }

  /** Starts the timers that make this a long-running process, rather than a driven loop. */
  run(): void {
    this.leadPoll = setInterval(() => {
      void this.publishLead();
    }, 1500);
    this.leadPoll.unref?.();
    this.pump = setInterval(() => {
      void this.settle().catch((error) =>
        this.log(`Settle failed: ${(error as Error).message}`),
      );
    }, 250);
    this.pump.unref?.();
    this.resync = setInterval(() => this.resyncAll(), this.config.resyncMs);
    this.resync.unref?.();
  }

  async stop(): Promise<void> {
    if (this.leadPoll) clearInterval(this.leadPoll);
    if (this.pump) clearInterval(this.pump);
    if (this.resync) clearInterval(this.resync);
    this.pump = this.resync = null;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.publishFailures.clear();
    await this.protocol.stop();
    await this.mcp?.close();
    this.mcp = null;
    await this.adapters.close();
    this.store.close();
  }

  /** Every non-terminal task gets a pass, about every 60 s (design §5.1). */
  resyncAll(): void {
    for (const task of this.store.tasks())
      if (!TERMINAL.includes(task.stage)) this.loop.enqueue(task.id);
  }

  /** Runs queued passes and the executor until nothing is left. Tests drive the loop with this. */
  async settle(): Promise<void> {
    await this.loop.settle();
  }

  // ---------------------------------------------------------------- tasks

  createTask(input: CreateTaskInput): TaskState {
    const repo = this.repoById(input.repoId);
    const now = this.now();
    const id = `t-${randomUUID().slice(0, 8)}` as TaskId;
    const task: Task = {
      id,
      repoId: repo.id,
      title: input.title,
      description: input.description,
      stage: "backlog",
      stageEnteredAt: now,
      version: 0,
      blocked: null,
      failed: null,
      requirePlanApproval: input.requirePlanApproval ?? false,
      reviewRound: 0,
      reviewRoundCap: 3,
      providers: input.providers ?? repo.defaultProviders,
      blockedBy: input.blockedBy ?? [],
      budgetMinutes: input.budgetMinutes ?? null,
      createdAt: now,
      updatedAt: now,
      worktreePath: null,
      branch: null,
      prNumber: null,
      attention: EMPTY_ATTENTION,
    };
    const state = this.store.createTask(task);
    this.loop.enqueue(id);
    return state;
  }

  /** A human command becomes an input; reconcile decides what it means (principle 3). */
  submitHuman(taskId: TaskId, command: HumanCommand): InputId {
    const input: Input = {
      id: randomUUID() as InputId,
      receivedAt: this.now(),
      type: "human",
      command,
    };
    this.store.enqueueInput(taskId, input);
    this.loop.enqueue(taskId);
    return input.id;
  }

  repo(taskId: TaskId): Repo {
    const task = this.store.loadTaskState(taskId).task;
    return this.repoById(task.repoId);
  }

  repoById(repoId: RepoId): Repo {
    const found = this.store.repos().find((r) => r.id === repoId);
    if (!found) throw new Error(`Unknown repo ${repoId}`);
    return found;
  }

  // ---------------------------------------------------------------- internals

  private launchDeps(): LaunchDeps {
    return {
      adapters: this.adapters,
      config: this.config,
      recipes: this.recipes,
      mcpEntry: (token) => ({
        type: "http",
        url: (this.mcpUrl ?? new URL("http://127.0.0.1:0/mcp")).toString(),
        headers: { Authorization: `Bearer ${token}` },
      }),
      now: () => this.now(),
    };
  }

  private mcpOptions(): ReturnType<Coordinator["mcpMiddleware"]> {
    this.mcpCache ??= this.mcpMiddleware();
    return this.mcpCache;
  }

  private mcpMiddleware() {
    const { host, resolveToken, buildAnchor } = createMcpHost({
      store: this.store,
      adapters: this.adapters,
      recipes: this.recipes,
      loop: this.loop,
      workflow: this.workflow,
      repo: (taskId) => this.repo(taskId),
    });
    return {
      host,
      buildAnchor,
      resolveToken: (token: string) =>
        this.lead.resolve(token) ?? resolveToken(token),
      leadHost: {
        invoke: async (name: string, input: Record<string, unknown>) => {
          if (name === "list_tasks") return this.store.tasks();
          if (name === "list_repos") return this.store.repos();
          if (name === "inspect_task")
            return inspectTask(
              this.store,
              input.taskId as TaskId,
              this.adapters,
            );
          return this.command(leadCommand(name, input));
        },
      },
    };
  }

  private subscribeHints(): void {
    const onHint = (hint: { worktreePath: string | null }) => {
      if (hint.worktreePath === this.store.dataDirectory) {
        void this.publishLead();
        return;
      }
      if (!hint.worktreePath) {
        this.resyncAll();
        return;
      }
      for (const task of this.store.tasks())
        if (task.worktreePath === hint.worktreePath) this.loop.enqueue(task.id);
    };
    this.timers.add(this.adapters.paneHost.subscribe(onHint));
    this.timers.add(this.adapters.claude.subscribe(onHint));
  }

  private schedule(taskId: TaskId, at: string, why: string): void {
    const delay = Math.max(0, Date.parse(at) - Date.parse(this.now()));
    this.log(`Scheduled ${why} for ${taskId} in ${delay} ms`);
    const cancel = this.after(delay, () => {
      this.loop.enqueue(taskId);
    });
    this.timers.add(cancel);
  }

  private async observe(
    state: TaskState,
    inputs: Input[],
  ): Promise<Observations> {
    const observations = await observeOwners(
      {
        adapters: this.adapters,
        config: this.config,
        pullRequests: this.pullRequests,
        capacity: { counts: () => this.store.capacityCounts() },
        dependencies: () => this.store.dependencyStages(state.task.id),
        inputs: () => inputs,
        launchedSessions: () =>
          new Set(
            this.recipes
              .all()
              .flatMap((recipe) => (recipe.sessionId ? [recipe.sessionId] : []))
              .concat(
                this.lead.sessionId ? [this.lead.sessionId as never] : [],
              ),
          ),
        coolingDownUntil: () => ({
          codex: this.cooldowns.get("codex") ?? null,
          claude: this.cooldowns.get("claude") ?? null,
        }),
        repoOf: (s) => {
          const repo = this.store.repos().find((r) => r.id === s.task.repoId);
          return repo
            ? { github: repo.github, baseBranch: repo.baseBranch }
            : null;
        },
        now: () => this.now(),
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
    return observations;
  }

  private onCommit(taskId: TaskId, result: ReconcileResult): void {
    // Stop the app-server if the task just transitioned to a terminal stage.
    const state = this.store.loadTaskState(taskId);
    if (TERMINAL.includes(state.task.stage)) {
      void this.adapters.stopCodexServer(taskId).catch((error) => {
        this.log(
          `Warning: could not stop Codex app-server for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    void this.publishTask(taskId, result).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const failures = this.publishFailures.get(taskId) ?? new Set<string>();
      // Log the error only once per (task, error message) pair
      if (!failures.has(errorMessage)) {
        failures.add(errorMessage);
        this.publishFailures.set(taskId, failures);
        this.log(
          `Could not publish ${taskId}: ${errorMessage} (further failures for this task/cause suppressed)`,
        );
      }
    });
  }

  private async publishTask(
    taskId: TaskId,
    _result: ReconcileResult,
  ): Promise<void> {
    if (!this.protocol.clients && !this.published.rows().length) return;
    const changes = await this.refreshTask(taskId);
    this.protocol.publish(changes);
    this.publishFailures.delete(taskId);
  }

  private viewDeps(): ViewDeps {
    return {
      store: this.store,
      adapters: this.adapters,
      recipes: this.recipes,
      config: this.config,
      now: () => this.now(),
    };
  }

  private async refreshTask(taskId: TaskId): Promise<Change[]> {
    const { rows } = await taskRows(this.viewDeps(), taskId);
    const changes = this.published.replace(`task:${taskId}`, taskId, rows);
    for (const key of this.diffScopes) {
      const [id, mode] = key.split("#");
      if (id !== taskId) continue;
      const diff = await changesRow(
        this.viewDeps(),
        taskId,
        mode as "whole_branch" | "since_last_review",
      );
      changes.push(
        ...this.published.replace(`diff:${key}`, taskId, diff ? [diff] : []),
      );
    }
    return changes;
  }

  private async publishLead(): Promise<void> {
    if (this.pollingLead) return;
    this.pollingLead = true;
    try {
      const value = await this.lead.state();
      this.protocol.publish(
        this.published.replace("lead", null, [
          { collection: "lead", key: "lead", value },
        ]),
      );
    } catch {
      this.log("Could not refresh Lead status");
    } finally {
      this.pollingLead = false;
    }
  }

  private async refreshAll(scope: readonly Subscription[]): Promise<void> {
    await this.ensure(scope);
    this.published.replace("lead", null, [
      { collection: "lead", key: "lead", value: await this.lead.state() },
    ]);
    this.published.replace(
      "repos",
      null,
      this.store.repos().map((repo) => ({
        collection: "repo" as const,
        key: repo.id,
        value: repo,
      })) as Row[],
    );
    for (const task of this.store.tasks()) await this.refreshTask(task.id);
  }

  private async ensure(scope: readonly Subscription[]): Promise<void> {
    for (const subscription of scope)
      if (subscription.kind === "diff")
        this.diffScopes.add(`${subscription.taskId}#${subscription.mode}`);
  }

  // ---------------------------------------------------------------- commands

  private async command(value: unknown): Promise<
    | { ok: true; result: unknown }
    | {
        ok: false;
        error: {
          code:
            | "unknown_task"
            | "unknown_run"
            | "unavailable"
            | "invalid_input"
            | "internal";
          message: string;
          details: string[];
        };
      }
  > {
    const command = commandSchema.parse(value) as {
      kind: string;
      taskId?: TaskId;
      runId?: string;
      command?: HumanCommand;
    } & Record<string, unknown>;
    try {
      switch (command.kind) {
        case "open_lead_session": {
          const target = await this.lead.open();
          await this.publishLead();
          return { ok: true, result: { kind: "attach_session", target } };
        }
        case "stop_lead_session": {
          await this.lead.stop();
          await this.publishLead();
          return { ok: true, result: { kind: "lead_stopped" } };
        }
        case "create_task": {
          const state = this.createTask({
            repoId: command.repoId as RepoId,
            title: command.title as string,
            description: command.description as string,
            providers: (command.providers ?? null) as ProviderRules | null,
            requirePlanApproval: (command.requirePlanApproval ?? null) as
              | boolean
              | null,
            blockedBy: (command.blockedBy ?? []) as TaskId[],
            budgetMinutes: (command.budgetMinutes ?? null) as number | null,
          });
          return {
            ok: true,
            result: { kind: "task_created", taskId: state.task.id },
          };
        }
        case "human": {
          if (!command.taskId || !command.command)
            return {
              ok: false,
              error: {
                code: "invalid_input",
                message: "A human command needs a task and a command",
                details: [],
              },
            };
          const taskId = command.taskId;
          const inputId = this.submitHuman(taskId, command.command);
          // Settle once to allow reconcile to run and set the disposition
          await this.settle();
          // Return the result with the disposition if available
          const disposition = this.store.inputDisposition(taskId, inputId);
          const result: Record<string, unknown> = {
            kind: "human",
            inputId,
          };
          if (disposition) {
            result.disposition = disposition;
          }
          return { ok: true, result };
        }
        case "open_attach_session": {
          const runId = command.runId as string;
          const recipe = this.recipes.get(runId as never);
          if (!recipe)
            return {
              ok: false,
              error: {
                code: "unknown_run",
                message: `No run ${runId}`,
                details: [],
              },
            };
          const { rows } = await taskRows(this.viewDeps(), recipe.taskId);
          const target = rows.find(
            (r) => r.collection === "run_target" && r.key === runId,
          );
          if (!target)
            return {
              ok: false,
              error: {
                code: "unknown_run",
                message: `Run ${runId} has no attach target`,
                details: [],
              },
            };
          return {
            ok: true,
            result: { kind: "attach_session", target: target.value },
          };
        }
        default:
          // The Workbench owns the diff and review-state requests; Phase 3 serves neither.
          return {
            ok: false,
            error: {
              code: "unavailable",
              message: `${command.kind} is not served in this phase`,
              details: ["The Workbench and its diff view land in Phase 4"],
            },
          };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
          details: [],
        },
      };
    }
  }
}
