// The coordinator: one long-running process per instance. It owns the loop, the executor, the MCP
// server agents call, and the protocol server windows connect to. Everything it talks to is
// injected, so a test can run the whole thing against `@loom/fake-agent` and a temporary store.
// CoordinatorLoop wires owner reads and execution; CoordinatorViews owns disposable projections;
// TaskInputs handles task creation and human inputs; createAgentMcp routes agent calls.
// This class composes them and keeps startup/shutdown ordering in one place.

import { randomUUID } from "node:crypto";
import type {
  HumanCommand,
  InputId,
  IsoTime,
  Repo,
  RepoId,
  RunId,
  TaskId,
  TaskState,
} from "@loom/core";
import { serveHttp } from "@loom/mcp";
import { command as commandSchema } from "@loom/protocol";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import { createAgentMcp } from "./agent-mcp.js";
import { Attachments } from "./attachments.js";
import { briefHandlers, DailyBriefs } from "./briefs.js";
import {
  dispatchCommand,
  type Handlers,
  type ServedCommandKind,
} from "./commands.js";
import {
  applyStoredSettingsToConfig,
  COORDINATOR_VERSION,
  type CoordinatorConfig,
  epochOf,
  reconcileConfig,
} from "./config.js";
import { CoordinatorLoop } from "./coordinator-loop.js";
import { CoordinatorViews } from "./coordinator-views.js";
import type { Executor } from "./executor.js";
import type { LaunchDeps } from "./launch.js";
import { LeadSession } from "./lead.js";
import { leadHandlers } from "./lead-commands.js";
import type { Loop } from "./loop.js";
import { PullRequestCache } from "./observe.js";
import { handlePullRequestCommand } from "./pull-requests.js";
import { RecipeStore } from "./recipes.js";
import { type RecoveryReport, recover } from "./recovery.js";
import { repoHandlers } from "./repos.js";
import { ProtocolServer } from "./server.js";
import { CoordinatorSettings } from "./settings.js";
import { runShell, type Shell } from "./shell.js";
import { type CreateTaskInput, taskHandlers } from "./task-commands.js";
import { TaskInputs } from "./task-inputs.js";
import { resolveCommandTaskRefs } from "./task-refs.js";
import { terminalHandlers } from "./terminals.js";
import { createWorkflowReader } from "./workflow.js";

export type { CreateTaskInput } from "./task-commands.js";

const TERMINAL = ["done", "canceled"];

export interface CoordinatorOptions {
  config: CoordinatorConfig;
  /** Unmodified environment/bootstrap config used when a stored override is reset. */
  baselineConfig?: CoordinatorConfig;
  store: Store;
  adapters: Adapters;
  /** Injected in tests so nothing depends on the wall clock. */
  now?: () => IsoTime;
  /** Injected in tests: a fake clock's `after`, so a schedule never waits in real time. */
  after?: (ms: number, callback: () => void) => () => void;
  log?: (message: string) => void;
  /** Skip the protocol listener (the CLI's one-shot commands do not need it). */
  serveProtocol?: boolean;
  /** Runs a repository's WORKFLOW `setup` command in a new worktree. Injected in tests. */
  shell?: Shell;
}

export class Coordinator {
  readonly config: CoordinatorConfig;
  readonly store: Store;
  readonly adapters: Adapters;
  readonly recipes: RecipeStore;
  private readonly taskInputs: TaskInputs;
  private readonly attachments: Attachments;
  private readonly settings: CoordinatorSettings;
  private readonly commandHandlers: Handlers<ServedCommandKind>;
  private readonly baselineConfig: CoordinatorConfig;
  readonly briefs: DailyBriefs;
  readonly leads = new Map<string, LeadSession>();
  private leadPoll: NodeJS.Timeout | null = null;
  private readonly views: CoordinatorViews;
  private readonly runtime: CoordinatorLoop;
  readonly loop: Loop;
  readonly executor: Executor;
  readonly protocol: ProtocolServer;
  readonly startedAt: IsoTime;
  readonly epoch: string;

  private panePoll: NodeJS.Timeout | null = null;
  private readonly pullRequests = new PullRequestCache();
  private readonly reportedAdapterFailures = new Set<string>();
  private readonly workflow = createWorkflowReader((message) =>
    this.log(message),
  );
  private readonly now: () => IsoTime;
  private readonly after: (ms: number, callback: () => void) => () => void;
  private readonly logger: (message: string) => void;
  // Built on first use: the fields it closes over are assigned in the constructor body.
  private mcpCache: ReturnType<typeof createAgentMcp> | null = null;
  private mcp: Awaited<ReturnType<typeof serveHttp>> | null = null;
  private resync: NodeJS.Timeout | null = null;

  constructor(private readonly options: CoordinatorOptions) {
    this.config = options.config;
    this.baselineConfig = structuredClone(
      options.baselineConfig ?? options.config,
    );
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
    this.briefs = new DailyBriefs({
      store: this.store,
      research: this.adapters.research,
      now: this.now,
      log: this.logger,
    });
    this.briefs.recover();
    this.startedAt = this.now();
    this.epoch = epochOf(this.startedAt);
    this.recipes = new RecipeStore(this.store.dataDirectory);
    this.attachments = new Attachments(this.store.dataDirectory);
    this.settings = new CoordinatorSettings({
      store: this.store,
      config: this.config,
      now: () => this.now(),
      onGlobalSaved: () => this.applyStoredRuntime(false),
      publish: () => this.views.publishSettings(),
    });
    this.store.setRoleProfilesResolver(
      (task) => this.settings.effective(task.repoId).roles,
    );
    this.runtime = new CoordinatorLoop({
      store: this.store,
      adapters: this.adapters,
      config: this.config,
      recipes: this.recipes,
      settings: this.settings,
      pullRequests: this.pullRequests,
      workflow: this.workflow,
      shell: options.shell ?? runShell,
      leads: this.leads,
      views: () => this.views,
      launchDeps: () => this.launchDeps(),
      repo: (id) => this.repo(id),
      repoById: (id) => this.repoById(id),
      now: this.now,
      after: this.after,
      log: (message) => this.log(message),
      reportAdapterFailure: (operation, error) =>
        this.reportAdapterFailure(operation, error),
    });
    this.loop = this.runtime.loop;
    this.executor = this.runtime.executor;
    this.views = new CoordinatorViews({
      store: this.store,
      adapters: this.adapters,
      recipes: this.recipes,
      config: this.config,
      settings: this.settings,
      leads: this.leads,
      leadFor: (id) => this.leadFor(id),
      repoById: (id) => this.repoById(id),
      loop: this.loop,
      executor: this.executor,
      pullRequests: this.pullRequests,
      protocol: () => this.protocol,
      now: this.now,
      after: this.after,
      log: (message) => this.log(message),
      reportAdapterFailure: (operation, error) =>
        this.reportAdapterFailure(operation, error),
    });
    this.taskInputs = new TaskInputs({
      store: this.store,
      config: this.config,
      settings: this.settings,
      loop: this.loop,
      repoById: (id) => this.repoById(id),
      now: this.now,
      log: (message) => this.log(message),
    });
    this.commandHandlers = {
      ...briefHandlers({ store: this.store, briefs: this.briefs }),
      ...this.settings.handlers(),
      ...terminalHandlers({
        store: this.store,
        adapters: this.adapters,
        config: this.config,
        inventory: this.views.inventory,
        repo: (id) => this.repoById(id),
        now: () => this.now(),
      }),
      ...leadHandlers({
        lead: (id) => this.leadFor(id),
        attachments: this.attachments,
        conversations: this.views.conversationViews,
        publishLead: () => this.views.publishLead(),
        refreshInventory: () => this.views.inventory.refresh(),
      }),
      ...repoHandlers({
        store: this.store,
        effectiveBaseBranch: () =>
          this.settings.effective().repository.baseBranch,
        lead: (id) => this.leadFor(id),
        now: () => this.now(),
        publishRepos: () => this.views.publishRepos(),
        publishSettings: () => this.views.publishSettings(),
        publishLead: () => this.views.publishLead(),
      }),
      ...taskHandlers({
        store: this.store,
        recipes: this.recipes,
        attachments: this.attachments,
        createTask: (input) => this.createTask(input),
        submitHuman: (taskId, command) => this.submitHuman(taskId, command),
        decision: (taskId, inputId) =>
          this.taskInputs.decision(taskId, inputId),
        viewDeps: () => this.views.viewDeps(),
      }),
    };
    this.protocol = new ProtocolServer({
      token: this.config.token,
      instance: this.config.instance,
      version: COORDINATOR_VERSION,
      startedAt: this.startedAt,
      epoch: this.epoch,
      heartbeatMs: this.config.heartbeatMs,
      bind: this.config.bind,
      now: () => this.now(),
      snapshot: () => this.views.published.rows(),
      command: (value) => this.command(value),
      ensure: (scope) => this.views.ensure(scope),
      scopesChanged: (scope) => {
        this.views.prViews.subscriptions(scope);
        this.views.conversationViews.subscriptions(scope);
      },
      onError: (error) => this.log(`Protocol error: ${error.message}`),
    });
  }

  log(message: string): void {
    this.logger(message);
  }

  private reportAdapterFailure(operation: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `${operation} failed: ${reason}`;
    if (this.reportedAdapterFailures.has(message)) return;
    this.reportedAdapterFailures.add(message);
    this.log(`${message} (further identical failures suppressed)`);
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
    this.applyStoredRuntime(true);
    await this.recipes.load();
    for (const repo of this.store.repos()) await this.leadFor(repo.id).load();
    const selected = this.store.selectedRepo();
    if (selected) this.store.selectRepo(selected);
    // Stable instance configuration wins; only ephemeral instances reuse the Main recipe's port.
    const mcpPort =
      this.config.mcpPort ||
      [...this.leads.values()].find((lead) => lead.mcpPort)?.mcpPort ||
      0;
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
    for (const lead of this.leads.values()) await lead.recover();
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
    // A finished task is not resynced, so backfill cleanup and resume its pending retries.
    for (const task of this.store.tasks())
      if (TERMINAL.includes(task.stage)) {
        const state = this.store.loadTaskState(task.id);
        const retries = state.outbox.filter(
          (row) => row.status === "failed" && row.retryAt,
        );
        if (
          (state.worktree && state.worktree.removedAt === null) ||
          state.outbox.some((row) => row.status === "pending") ||
          retries.length
        )
          this.loop.enqueue(task.id);
        // A succeeded schedule row cannot restore its in-memory timer after a restart.
        for (const row of retries)
          if (row.retryAt && row.retryAt > this.now())
            this.runtime.schedule(task.id, row.retryAt, "retry recovery");
      }
    await this.views.refreshAll([]);
    await this.views.inventory.refresh();
    this.panePoll = setInterval(
      () => void this.views.inventory.refresh(),
      2000,
    );
    this.panePoll.unref?.();
    this.runtime.subscribeHints();
    if (this.options.serveProtocol !== false) await this.protocol.start();
    return report;
  }

  /** Starts the timers that make this a long-running process, rather than a driven loop. */
  run(): void {
    this.briefs.start();
    this.leadPoll = setInterval(() => void this.pollLeads(), 1500);
    this.leadPoll.unref?.();
    // Event-driven from here: every enqueue starts its pass, and every pass drains the executor.
    this.loop.start();
    void this.executor.drain();
    this.resync = setInterval(() => this.resyncAll(), this.config.resyncMs);
    this.resync.unref?.();
  }

  leadFor(repoId: string): LeadSession {
    const repo = this.store.repos().find((repo) => repo.id === repoId);
    if (!repo) throw new Error("Unknown registered repository");
    let lead = this.leads.get(repoId);
    if (!lead) {
      lead = new LeadSession({
        adapters: this.adapters,
        store: this.store,
        config: this.config,
        dataDirectory: this.store.dataDirectory,
        repo,
        mcpEntry: (token) => this.launchDeps().mcpEntry(token),
        now: () => this.now(),
        log: (message) => this.log(message),
      });
      this.leads.set(repoId, lead);
    }
    return lead;
  }

  async pollLeads(): Promise<void> {
    await Promise.all(
      [...this.leads.values()].map(async (lead) => {
        try {
          await lead.flushQueued();
          await lead.confirmMessages();
          this.views.conversationViews.hint(lead.sessionId);
        } catch (error) {
          this.log(
            `Main poll failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    await this.views.publishLead();
  }

  async stop(): Promise<void> {
    await this.briefs.stop();
    await this.views.prViews.stop();
    await this.views.conversationViews.stop();
    if (this.panePoll) clearInterval(this.panePoll);
    await this.views.inventory.stop();
    if (this.leadPoll) clearInterval(this.leadPoll);
    this.loop.stop();
    if (this.resync) clearInterval(this.resync);
    this.resync = null;
    this.runtime.cancelTimers();
    this.views.clearFailures();
    await this.protocol.stop();
    await this.mcp?.close();
    this.mcp = null;
    await this.adapters.close();
    this.store.close();
  }

  resyncAll(): void {
    this.runtime.resyncAll();
  }

  /** Whether a fresh pass has confirmed the task's latest commit, so its actions may run. */
  confirmed(taskId: TaskId): boolean {
    return this.loop.isVerified(taskId);
  }

  /** Runs queued passes and the executor until nothing is left. Tests drive the loop with this. */
  async settle(): Promise<void> {
    await this.loop.settle();
  }

  createTask(input: CreateTaskInput): TaskState {
    return this.taskInputs.createTask(input);
  }

  submitHuman(taskId: TaskId, command: HumanCommand): InputId {
    return this.taskInputs.submitHuman(taskId, command);
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
      dataDirectory: this.store.dataDirectory,
    };
  }

  private applyStoredRuntime(startup: boolean): void {
    const global = this.store.settings.read({ kind: "global" }).data;
    applyStoredSettingsToConfig(
      this.config,
      this.baselineConfig,
      global,
      startup,
    );
    this.store.setReconcileConfig(reconcileConfig(this.config));
    this.adapters.github.setExcludedAuthors?.(this.config.excludedAuthors);
    if (!startup && this.resync) {
      clearInterval(this.resync);
      this.resync = setInterval(() => this.resyncAll(), this.config.resyncMs);
      this.resync.unref?.();
    }
  }

  private mcpOptions(): ReturnType<typeof createAgentMcp> {
    this.mcpCache ??= createAgentMcp({
      store: this.store,
      adapters: this.adapters,
      recipes: this.recipes,
      loop: this.loop,
      workflow: this.workflow,
      leads: this.leads,
      leadFor: (id) => this.leadFor(id),
      repo: (id) => this.repo(id),
      repoById: (id) => this.repoById(id),
      now: this.now,
      log: (message) => this.log(message),
      reportAdapterFailure: (operation, error) =>
        this.reportAdapterFailure(operation, error),
      command: (value) => this.command(value),
    });
    return this.mcpCache;
  }

  // ---------------------------------------------------------------- commands

  private async command(value: unknown) {
    const pullRequest = await handlePullRequestCommand(
      value,
      this.views.prViews,
      (repoId) => this.store.repos().some((repo) => repo.id === repoId),
    );
    if (pullRequest) return pullRequest;
    const parsed = commandSchema.parse(value);
    const resolved = resolveCommandTaskRefs(parsed, this.store);
    if (!resolved.ok) return resolved;
    return dispatchCommand(resolved.command, this.commandHandlers);
  }
}
