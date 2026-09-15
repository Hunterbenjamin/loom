import {
  type ProtocolError,
  paneIdentity,
  pullRequestCommand,
  pullRequestDiffRead,
  pullRequestReviewChange,
} from "@loom/protocol";
import { Attachments, withAttachedFiles } from "./attachments.js";
import { DailyBriefs } from "./briefs.js";
import { ConversationViews } from "./conversations.js";
import { PaneInventory, paneKey } from "./pane-inventory.js";
import { PullRequestViews } from "./pull-requests.js";
import { runEnvironment } from "./recipes.js";
// The coordinator: one long-running process per instance. It owns the loop, the executor, the MCP
// server agents call, and the protocol server windows connect to. Everything it talks to is
// injected, so a test can run the whole thing against `@loom/fake-agent` and a temporary store.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  Attention,
  HumanCommand,
  Input,
  InputDisposition,
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
  WorktreePath,
} from "@loom/core";
import {
  DEFAULT_SETTINGS,
  displayName,
  issueKey,
  MODEL_CATALOG,
  resolveSettings,
  resolveTaskRef,
  SETTINGS_CATALOG,
  type SettingsPatch,
  type SettingsScope,
  type SettingsValues,
  settingValue,
  validateSettings,
} from "@loom/core";
import { leadCommand, serveHttp } from "@loom/mcp";
import type { Change, Subscription } from "@loom/protocol";
import { command as commandSchema } from "@loom/protocol";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import {
  applyStoredSettingsToConfig,
  COORDINATOR_VERSION,
  type CoordinatorConfig,
  epochOf,
  reconcileConfig,
} from "./config.js";
import { classify, Executor, PreconditionFailed } from "./executor.js";
import { inspectTask } from "./inspect.js";
import type { LaunchDeps } from "./launch.js";
import { LeadSession } from "./lead.js";
import { Loop } from "./loop.js";
import { messageAgent } from "./main-messages.js";
import { createMcpHost } from "./mcp-host.js";
import {
  capacityReading,
  observe as observeOwners,
  PullRequestCache,
} from "./observe.js";
import { RecipeStore } from "./recipes.js";
import { type RecoveryReport, recover } from "./recovery.js";
import { registerRepo } from "./repos.js";
import { ProtocolServer } from "./server.js";
import { migrateSettings } from "./settings-migration.js";
import { runShell, type Shell } from "./shell.js";
import { resolveCommandTaskRefs } from "./task-refs.js";
import { openTaskTerminal } from "./task-terminal.js";
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

export interface CreateTaskInput {
  repoId: RepoId;
  title: string;
  name?: string | null;
  description: string;
  summary?: string | null;
  providers?: ProviderRules | null;
  requirePlanApproval?: boolean | null;
  blockedBy?: TaskId[];
  budgetMinutes?: number | null;
  size?: "small" | "normal" | null;
}

const settingsId = (scope: SettingsScope): string =>
  scope.kind === "global" ? "global" : `repo:${scope.repoId}`;

const mergeStored = (
  current: SettingsPatch,
  patch: SettingsPatch,
): SettingsPatch => ({
  ...current,
  ...patch,
  ...(patch.roles
    ? {
        roles: Object.fromEntries(
          Object.entries({ ...current.roles, ...patch.roles }).map(
            ([role, value]) => [
              role,
              {
                ...current.roles?.[
                  role as keyof NonNullable<SettingsPatch["roles"]>
                ],
                ...value,
              },
            ],
          ),
        ),
      }
    : {}),
  ...(patch.workflow
    ? { workflow: { ...current.workflow, ...patch.workflow } }
    : {}),
  ...(patch.repository
    ? { repository: { ...current.repository, ...patch.repository } }
    : {}),
  ...(patch.main ? { main: { ...current.main, ...patch.main } } : {}),
  ...(patch.runtime
    ? { runtime: { ...current.runtime, ...patch.runtime } }
    : {}),
  ...(patch.appearance
    ? { appearance: { ...current.appearance, ...patch.appearance } }
    : {}),
});

const removeSettings = (
  current: SettingsPatch,
  keys: readonly string[],
): SettingsPatch => {
  const next = structuredClone(current) as Record<string, unknown>;
  for (const path of keys) {
    const parts = path.split(".");
    let parent: Record<string, unknown> | undefined = next;
    for (const part of parts.slice(0, -1)) {
      const child: unknown = parent?.[part];
      parent =
        child && typeof child === "object"
          ? (child as Record<string, unknown>)
          : undefined;
    }
    if (parent) delete parent[parts.at(-1) ?? ""];
  }
  return next as SettingsPatch;
};

const changedSettings = (before: SettingsPatch, after: SettingsPatch) =>
  SETTINGS_CATALOG.flatMap(({ key }) => {
    const oldValue = settingValue(before, key);
    const newValue = settingValue(after, key);
    return JSON.stringify(oldValue) === JSON.stringify(newValue)
      ? []
      : [{ key, oldValue, newValue }];
  });

/** A pass whose owner reads take this long is logged, so slow owners show up in the log. */
const SLOW_READ_MS = 2000;

export class Coordinator {
  readonly config: CoordinatorConfig;
  readonly store: Store;
  readonly adapters: Adapters;
  readonly recipes: RecipeStore;
  private readonly attachments: Attachments;
  private readonly baselineConfig: CoordinatorConfig;
  readonly briefs: DailyBriefs;
  readonly leads = new Map<string, LeadSession>();
  private readonly schedules = new Map<
    string,
    { at: string; cancel: () => void }
  >();
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
  private async leadRows(): Promise<Row[]> {
    return Promise.all(
      this.store.repos().map(async (repo) => ({
        collection: "lead" as const,
        key: repo.id,
        value: await this.leadFor(repo.id).state(),
      })),
    );
  }
  private projectRows(): Row[] {
    return [
      {
        collection: "project",
        key: "project",
        value: { id: "project", repoId: this.store.selectedRepo() },
      },
    ];
  }
  private effectiveSettings(repoId?: string): SettingsValues {
    const global = this.store.settings.read({ kind: "global" }).data;
    const repository = repoId
      ? this.store.settings.read({ kind: "repository", repoId }).data
      : null;
    return resolveSettings(
      global,
      repository,
      this.config.settingsEnvironment,
      DEFAULT_SETTINGS,
      this.config.providerEnvironment,
    ).effective;
  }
  private settingsRows(): Row[] {
    const global = this.store.settings.read({ kind: "global" });
    const audit = this.store.settings.audit(100);
    const scopes: SettingsScope[] = [
      { kind: "global" },
      ...this.store
        .repos()
        .map((repo) => ({ kind: "repository" as const, repoId: repo.id })),
    ];
    return scopes.map((scope) => {
      const stored =
        scope.kind === "global" ? global : this.store.settings.read(scope);
      const resolution = resolveSettings(
        global.data,
        scope.kind === "repository" ? stored.data : null,
        this.config.settingsEnvironment,
        DEFAULT_SETTINGS,
        this.config.providerEnvironment,
      );
      return {
        collection: "settings" as const,
        key: settingsId(scope),
        value: {
          id: settingsId(scope),
          scope,
          version: stored.version,
          stored: stored.data,
          defaults: DEFAULT_SETTINGS,
          effective: resolution.effective,
          sources: resolution.sources,
          catalog: SETTINGS_CATALOG,
          modelCatalog: MODEL_CATALOG,
          credentialReadiness: {
            codex: Boolean(
              process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
            ),
            claude: Boolean(process.env.ANTHROPIC_API_KEY),
            github: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
          },
          audit: audit.filter(
            (entry) => settingsId(entry.scope) === settingsId(scope),
          ),
        },
      };
    });
  }
  private publishSettings(): void {
    this.protocol.publish(
      this.published.replace("settings", null, this.settingsRows()),
    );
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
  private saveSettings(
    scope: SettingsScope,
    expectedVersion: number,
    next: SettingsPatch,
  ): number {
    if (
      scope.kind === "repository" &&
      !this.store.repos().some((repo) => repo.id === scope.repoId)
    )
      throw Object.assign(new Error("Unknown registered repository"), {
        code: "invalid_input",
      });
    const current = this.store.settings.read(scope);
    const changes = changedSettings(current.data, next);
    if (!changes.length)
      throw Object.assign(new Error("No settings changed"), {
        code: "invalid_input",
      });
    const unavailable = changes
      .map((change) => SETTINGS_CATALOG.find((item) => item.key === change.key))
      .filter(
        (item) => !item || item.readOnly || !item.scopes.includes(scope.kind),
      );
    if (unavailable.length)
      throw Object.assign(new Error("Setting is not editable in this scope"), {
        code: "invalid_input",
        details: unavailable.map((item) => item?.key ?? "unknown setting"),
      });
    const global =
      scope.kind === "global"
        ? next
        : this.store.settings.read({ kind: "global" }).data;
    const repositories =
      scope.kind === "repository"
        ? [{ id: scope.repoId, data: next }]
        : this.store.repos().map((repo) => ({
            id: repo.id,
            data: this.store.settings.read({
              kind: "repository",
              repoId: repo.id,
            }).data,
          }));
    const validateResolved = (
      repositoryData: SettingsPatch | null,
      environment: SettingsPatch | null,
    ) => {
      const effective = resolveSettings(
        global,
        repositoryData,
        environment,
        DEFAULT_SETTINGS,
        this.config.providerEnvironment,
      ).effective;
      return validateSettings(effective);
    };
    const errors = [
      ...validateResolved(null, null),
      ...validateResolved(null, this.config.settingsEnvironment),
      ...repositories.flatMap((repo) =>
        [
          ...validateResolved(repo.data, null),
          ...validateResolved(repo.data, this.config.settingsEnvironment),
        ].map((message) => `${repo.id}: ${message}`),
      ),
    ];
    if (errors.length)
      throw Object.assign(new Error("Settings validation failed"), {
        code: "invalid_input",
        details: errors,
      });
    const saved = this.store.settings.update({
      scope,
      expectedVersion,
      data: next,
      actor: "desktop",
      changedAt: this.now(),
      changes,
    });
    if (scope.kind === "global") this.applyStoredRuntime(false);
    this.publishSettings();
    return saved.version;
  }
  private publishRepos(): void {
    this.protocol.publish([
      ...this.published.replace(
        "repos",
        null,
        this.store
          .repos()
          .map((repo) => ({ collection: "repo", key: repo.id, value: repo })),
      ),
      ...this.published.replace("project", null, this.projectRows()),
    ]);
  }
  private leadPoll: NodeJS.Timeout | null = null;
  private pollingLead = false;
  readonly loop: Loop;
  readonly executor: Executor;
  private readonly prViews: PullRequestViews;
  private readonly conversationViews: ConversationViews;
  readonly protocol: ProtocolServer;
  readonly startedAt: IsoTime;
  readonly epoch: string;

  private readonly published = new PublishedRows();
  private inventory!: PaneInventory;
  private panePoll: NodeJS.Timeout | null = null;
  private readonly pullRequests = new PullRequestCache();
  private readonly cooldowns = new Map<Provider, IsoTime | null>();
  private readonly timers = new Set<() => void>();
  private readonly diffScopes = new Set<string>();
  private readonly publishFailures = new Map<TaskId, Set<string>>();
  private readonly reportedAdapterFailures = new Set<string>();
  private readonly workflow = createWorkflowReader((message) =>
    this.log(message),
  );
  private readonly now: () => IsoTime;
  private readonly after: (ms: number, callback: () => void) => () => void;
  private readonly logger: (message: string) => void;
  // Built on first use: the fields it closes over are assigned in the constructor body.
  private mcpCache: ReturnType<Coordinator["mcpMiddleware"]> | null = null;
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
    this.store.setRoleProfilesResolver(
      (task) => this.effectiveSettings(task.repoId).roles,
    );
    this.loop = new Loop({
      store: this.store,
      drainExecutor: () => this.executor.drain(),
      observe: (state, inputs) => this.observe(state, inputs),
      rebase: (readings, inputs) => ({
        ...readings,
        now: this.now() as never,
        capacity: capacityReading(this.capacityDeps()),
        inputs,
      }),
      onCommit: ({ taskId, result }) => this.onCommit(taskId, result),
      onError: (error, taskId) => {
        this.log(`Pass for ${taskId} failed: ${error.message}`);
      },
    });
    this.executor = new Executor({
      store: this.store,
      adapters: this.adapters,
      config: this.config,
      launch: this.launchDeps(),
      pullRequests: this.pullRequests,
      workflow: this.workflow,
      shell: options.shell ?? runShell,
      repo: (taskId) => this.repo(taskId),
      repoById: (repoId) => this.repoById(repoId),
      repositorySettings: (repoId) => this.effectiveSettings(repoId).repository,
      schedule: (taskId, at, why) => this.schedule(taskId, at, why),
      notify: (level, title, body) => this.log(`[${level}] ${title}: ${body}`),
      now: () => this.now(),
      nextInputId: () => randomUUID() as InputId,
      onResult: (taskId) => this.loop.enqueue(taskId),
      mayAct: (taskId) => this.loop.isVerified(taskId),
      onUnconfirmed: (taskId) => this.loop.enqueue(taskId),
      reportAdapterFailure: (operation, error) =>
        this.reportAdapterFailure(operation, error),
    });
    this.prViews = new PullRequestViews({
      viewedFiles: (repo, number, head) =>
        this.store.pullRequestViewedFiles(repo, number, head),
      saveReviewState: (command) =>
        this.store.savePullRequestReviewState(command),
      preferences: (repo, number) =>
        this.store.pullRequestPreferences(repo, number),
      log: (message) => this.log(message),
      github: this.adapters.github,
      repo: (id) => this.repoById(id),
      tasks: () => this.store.tasks(),
      replace: (owner, rows) =>
        this.protocol.publish(this.published.replace(owner, null, rows)),
      after: this.after,
      action: (command) => this.executor.pullRequest(command),
      linksChanged: async (repo) => {
        for (const task of this.store.tasks())
          if (task.repoId === repo.id)
            this.protocol.publish(await this.refreshTask(task.id));
      },
      merged: (repo, head) => {
        for (const task of this.store.tasks())
          if (
            task.repoId === repo.id &&
            task.branch === head &&
            task.stage !== "done"
          ) {
            this.pullRequests.forget(repo.github, head);
            this.loop.enqueue(task.id);
          }
      },
      changed: (repo) => {
        for (const task of this.store.tasks())
          if (
            task.repoId === repo.id &&
            task.branch &&
            !TERMINAL.includes(task.stage)
          ) {
            this.pullRequests.forget(repo.github, task.branch);
            this.loop.enqueue(task.id);
          }
      },
      onError: (error) =>
        this.log(
          `Could not refresh pull requests: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    this.conversationViews = new ConversationViews({
      store: this.store,
      adapters: this.adapters,
      lead: (repoId) => this.leadFor(repoId),
      now: () => this.now(),
      after: this.after,
      replace: (owner, rows) =>
        this.protocol.publish(this.published.replace(owner, null, rows)),
      log: (message) => this.log(message),
    });
    this.inventory = new PaneInventory(
      this.adapters.paneHost,
      this.adapters.git,
      () => ({
        states: this.store.tasks().map((t) => this.store.loadTaskState(t.id)),
        repos: this.store.repos(),
        now: this.now(),
        leadPanes: new Set(
          [...this.leads.entries()].flatMap(([id, lead]) =>
            lead.paneRef &&
            this.published
              .rows()
              .some(
                (r) =>
                  r.collection === "lead" &&
                  r.key === id &&
                  (r.value as { status: string }).status === "waiting",
              )
              ? [paneKey(lead.paneRef)]
              : [],
          ),
        ),
      }),
      (panes, unavailable) => {
        this.protocol.publish(
          this.published.replace("panes", null, [
            ...panes.map((value) => ({
              collection: "pane" as const,
              key: value.id,
              value,
            })),
            {
              collection: "pane_inventory",
              key: "panes",
              value: { id: "panes", unavailable },
            },
          ]),
        );
      },
      (operation, error) => this.reportAdapterFailure(operation, error),
    );
    this.protocol = new ProtocolServer({
      token: this.config.token,
      instance: this.config.instance,
      version: COORDINATOR_VERSION,
      startedAt: this.startedAt,
      epoch: this.epoch,
      heartbeatMs: this.config.heartbeatMs,
      bind: this.config.bind,
      now: () => this.now(),
      snapshot: () => this.published.rows(),
      command: (value) => this.command(value),
      ensure: (scope) => this.ensure(scope),
      scopesChanged: (scope) => {
        this.prViews.subscriptions(scope);
        this.conversationViews.subscriptions(scope);
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
    migrateSettings(this.store, this.baselineConfig, this.now());
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
            this.schedule(task.id, row.retryAt, "retry recovery");
      }
    await this.refreshAll([]);
    await this.inventory.refresh();
    this.panePoll = setInterval(() => void this.inventory.refresh(), 2000);
    this.panePoll.unref?.();
    this.subscribeHints();
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

  async pollLeads(): Promise<void> {
    await Promise.all(
      [...this.leads.values()].map(async (lead) => {
        try {
          await lead.flushQueued();
          await lead.confirmMessages();
          this.conversationViews.hint(lead.sessionId);
        } catch (error) {
          this.log(
            `Main poll failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    await this.publishLead();
  }

  async stop(): Promise<void> {
    await this.briefs.stop();
    await this.prViews.stop();
    await this.conversationViews.stop();
    if (this.panePoll) clearInterval(this.panePoll);
    await this.inventory.stop();
    if (this.leadPoll) clearInterval(this.leadPoll);
    this.loop.stop();
    if (this.resync) clearInterval(this.resync);
    this.resync = null;
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

  /** Whether a fresh pass has confirmed the task's latest commit, so its actions may run. */
  confirmed(taskId: TaskId): boolean {
    return this.loop.isVerified(taskId);
  }

  /** Runs queued passes and the executor until nothing is left. Tests drive the loop with this. */
  async settle(): Promise<void> {
    await this.loop.settle();
  }

  // ---------------------------------------------------------------- tasks

  createTask(input: CreateTaskInput): TaskState {
    const repo = this.repoById(input.repoId);
    const settings = this.effectiveSettings(repo.id);
    const now = this.now();
    const id = `t-${randomUUID().slice(0, 8)}` as TaskId;
    const task: Omit<Task, "number"> = {
      id,
      repoId: repo.id,
      name: input.name ?? null,
      title: input.title,
      description: input.description,
      summary: input.summary ?? null,
      stage: "backlog",
      stageEnteredAt: now,
      version: 0,
      blocked: null,
      failed: null,
      requirePlanApproval:
        input.requirePlanApproval ?? settings.workflow.requirePlanApproval,
      mergePolicy: settings.workflow.mergePolicy,
      reviewRound: 0,
      reviewRoundCap: settings.workflow.reviewRoundCap,
      roleProfiles: Object.fromEntries(
        (["planner", "implementer", "reviewer"] as const).map((role) => {
          const profile = settings.roles[role];
          const provider = input.providers?.[role] ?? profile.provider;
          return [
            role,
            provider === profile.provider
              ? profile
              : {
                  ...profile,
                  provider,
                  model: this.config.models[provider],
                  reasoningEffort:
                    provider === "codex"
                      ? (this.config.codexReasoningEffort ?? "medium")
                      : null,
                },
          ];
        }),
      ) as Task["roleProfiles"],
      providers: {
        planner: input.providers?.planner ?? settings.roles.planner.provider,
        implementer:
          input.providers?.implementer ?? settings.roles.implementer.provider,
        reviewer: input.providers?.reviewer ?? settings.roles.reviewer.provider,
      },
      blockedBy: input.blockedBy ?? [],
      budgetMinutes: input.budgetMinutes ?? settings.workflow.budgetMinutes,
      size: input.size ?? settings.workflow.size,
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

  /**
   * A human command becomes an input; reconcile decides what it means (principle 3). It is decided
   * at once against the task's last readings when it can be (design §5.1a), and a pass follows.
   */
  submitHuman(taskId: TaskId, command: HumanCommand): InputId {
    const started = performance.now();
    const input: Input = {
      id: randomUUID() as InputId,
      receivedAt: this.now(),
      type: "human",
      command,
    };
    this.store.enqueueInput(taskId, input);
    const applied = this.loop.applyHuman(taskId);
    if (applied)
      this.log(
        `${command.type} for ${taskId} decided in ${(performance.now() - started).toFixed(1)} ms`,
      );
    return input.id;
  }

  /**
   * What reconcile decided about an input. Decided inputs answer at once; otherwise (no readings
   * yet in this process, or an agent's input first in line) this runs the passes that decide it.
   */
  private async decision(
    taskId: TaskId,
    inputId: InputId,
  ): Promise<InputDisposition> {
    for (let pass = 0; pass < 50; pass++) {
      const disposition = this.store.inputDisposition(taskId, inputId);
      if (disposition) return disposition;
      await this.loop.pass(taskId);
    }
    throw new Error(`Input ${inputId} was queued but not consumed`);
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
      log: (message) => this.log(message),
      reportAdapterFailure: (operation, error) =>
        this.reportAdapterFailure(operation, error),
    });
    return {
      host,
      buildAnchor,
      log: (message: string) => this.log(`MCP: ${message}`),
      resolveToken: (token: string) =>
        [...this.leads.values()]
          .map((lead) => lead.resolve(token))
          .find(Boolean) ?? resolveToken(token),
      leadHost: {
        invoke: async (
          name: string,
          input: Record<string, unknown>,
          repoId?: string,
        ) => {
          if (!repoId) throw new Error("Main repository identity is required");
          const lead = this.leadFor(repoId);
          const tasks = this.store.tasks();
          const repos = this.store.repos();
          const resolveLeadRef = (reference: string) => {
            const result = resolveTaskRef(reference, { tasks, repos, repoId });
            if (!result.ok) throw new Error(result.message);
            return result.task.id;
          };
          if (name === "message_agent") {
            if (
              typeof input.to === "object" &&
              input.to !== null &&
              "taskId" in input.to &&
              typeof input.to.taskId === "string"
            ) {
              const result = resolveTaskRef(input.to.taskId, {
                tasks,
                repos,
                repoId,
              });
              if (!result.ok)
                return { delivered: "refused", reason: result.message };
              input = {
                ...input,
                to: { ...input.to, taskId: result.task.id },
              };
            }
            return messageAgent(
              {
                store: this.store,
                adapters: this.adapters,
                now: () => this.now(),
                enqueue: (taskId) => this.loop.enqueue(taskId),
              },
              repoId,
              input,
            );
          }
          if (name === "set_note") return lead.setNote(input.note as string);
          if (name === "list_tasks") {
            const repo = this.repoById(repoId as RepoId);
            return tasks
              .filter((task) => task.repoId === repoId)
              .map((task) => ({
                ...task,
                issue: issueKey(repo, task),
                displayName: displayName(task),
              }));
          }
          if (name === "list_repos")
            return this.store.repos().filter((repo) => repo.id === repoId);
          if (typeof input.taskId === "string")
            input = { ...input, taskId: resolveLeadRef(input.taskId) };
          if (input.repoId && input.repoId !== repoId)
            throw new Error("Repository is outside Main's scope");
          if (name === "create_task") input = { ...input, repoId };
          if (Array.isArray(input.blockedBy))
            input = {
              ...input,
              blockedBy: input.blockedBy.map((value) =>
                resolveLeadRef(String(value)),
              ),
            };
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
    const onHint = (hint: {
      worktreePath: string | null;
      sessionId: string | null;
    }) => {
      this.conversationViews.hint(hint.sessionId);
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
    this.timers.add(
      this.adapters.paneHost.subscribe((hint) => {
        void this.inventory.refresh();
        onHint(hint);
      }),
    );
    this.timers.add(this.adapters.claude.subscribe(onHint));
  }

  private schedule(taskId: TaskId, at: string, why: string): void {
    const key = `${taskId}:${why}`;
    const previous = this.schedules.get(key);
    if (previous?.at === at) return;
    if (previous) {
      previous.cancel();
      this.timers.delete(previous.cancel);
    }
    const delay = Math.max(0, Date.parse(at) - Date.parse(this.now()));
    this.log(`Scheduled ${why} for ${taskId} in ${delay} ms`);
    const cancel = this.after(delay, () => {
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
      config: this.config,
      capacity: { counts: () => this.store.capacityCounts() },
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
        adapters: this.adapters,
        ...this.capacityDeps(),
        pullRequests: this.pullRequests,
        dependencies: () => this.store.dependencyStages(state.task.id),
        inputs: () => inputs,
        launchedSessions: () =>
          new Set(
            this.recipes
              .all()
              .flatMap((recipe) => (recipe.sessionId ? [recipe.sessionId] : []))
              .concat(
                [...this.leads.values()]
                  .map((lead) => lead.sessionId)
                  .filter(Boolean) as never[],
              ),
          ),
        repoOf: (s) => {
          const repo = this.store.repos().find((r) => r.id === s.task.repoId);
          return repo
            ? {
                github: repo.github,
                baseBranch: this.effectiveSettings(repo.id).repository
                  .baseBranch,
              }
            : null;
        },
        now: () => this.now(),
        reportAdapterFailure: (operation, error) =>
          this.reportAdapterFailure(operation, error),
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
    observations.workflowCommands = await this.workflow.read(
      this.repo(state.task.id).root,
    );
    const elapsed = performance.now() - started;
    if (elapsed >= SLOW_READ_MS)
      this.log(
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
    await this.inventory.refresh();
  }

  private viewDeps(): ViewDeps {
    return {
      store: this.store,
      adapters: this.adapters,
      recipes: this.recipes,
      config: this.config,
      now: () => this.now(),
      reportAdapterFailure: (operation, error) =>
        this.reportAdapterFailure(operation, error),
    };
  }

  private async refreshTask(taskId: TaskId): Promise<Change[]> {
    const { rows } = await taskRows(this.viewDeps(), taskId);
    const changes = this.published.replace(`task:${taskId}`, taskId, rows);
    this.prViews.relink();
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
      const changes = this.published.replace(
        "lead",
        null,
        await this.leadRows(),
      );
      this.protocol.publish(changes);
      if (changes.length) void this.inventory.refresh();
    } catch {
      this.log("Could not refresh Main status");
    } finally {
      this.pollingLead = false;
    }
  }

  private async refreshAll(scope: readonly Subscription[]): Promise<void> {
    await this.ensure(scope);
    this.published.replace("lead", null, await this.leadRows());
    this.published.replace("project", null, this.projectRows());
    this.published.replace("settings", null, this.settingsRows());
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
    await this.prViews.ensure(scope);
    this.conversationViews.ensure(scope);
    for (const subscription of scope) {
      if (subscription.kind !== "diff") continue;
      const key = `${subscription.taskId}#${subscription.mode}`;
      if (this.diffScopes.has(key)) continue;
      this.diffScopes.add(key);
      const diff = await changesRow(
        this.viewDeps(),
        subscription.taskId,
        subscription.mode,
      );
      this.protocol.publish(
        this.published.replace(
          `diff:${key}`,
          subscription.taskId,
          diff ? [diff] : [],
        ),
      );
    }
  }

  // ---------------------------------------------------------------- commands

  private async command(
    value: unknown,
  ): Promise<
    { ok: true; result: unknown } | { ok: false; error: ProtocolError }
  > {
    const review = pullRequestReviewChange.safeParse(value);
    const diffRead = pullRequestDiffRead.safeParse(value);
    if (review.success || diffRead.success) {
      try {
        if (review.success) {
          await this.prViews.saveReview(review.data);
          return { ok: true, result: { kind: "pull_request_review_state" } };
        }
        if (diffRead.success)
          return {
            ok: true,
            result: await this.prViews.readDiff(diffRead.data),
          };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "guard_failed",
            message:
              error instanceof Error
                ? error.message
                : "Could not read review state",
            details: [],
          },
        };
      }
    }
    const pr = pullRequestCommand.safeParse(value);
    if (pr.success) {
      if (!this.store.repos().some((repo) => repo.id === pr.data.repoId))
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: "Unknown registered repository",
            details: [],
          },
        };
      try {
        await this.prViews.command(pr.data);
        return {
          ok: true,
          result: {
            kind: "pull_request_action",
            command: pr.data.kind,
            repoId: pr.data.repoId,
            number: "number" in pr.data ? pr.data.number : null,
          },
        };
      } catch (error) {
        const classified = classify(error);
        return {
          ok: false,
          error: {
            code:
              classified.code === "precondition"
                ? "guard_failed"
                : classified.code === "retryable"
                  ? "unavailable"
                  : "internal",
            message: classified.message,
            details: [],
          },
        };
      }
    }
    const parsedCommand = commandSchema.parse(value);
    const resolved = resolveCommandTaskRefs(parsedCommand, this.store);
    if (!resolved.ok) return resolved;
    const command = resolved.command as {
      kind: string;
      taskId?: TaskId;
      runId?: string;
      command?: HumanCommand;
    } & Record<string, unknown>;
    try {
      switch (command.kind) {
        case "update_settings": {
          const scope = command.scope as SettingsScope;
          const current = this.store.settings.read(scope);
          const version = this.saveSettings(
            scope,
            command.expectedVersion as number,
            mergeStored(current.data, command.patch as SettingsPatch),
          );
          return {
            ok: true,
            result: { kind: "settings_updated", scope, version },
          };
        }
        case "reset_settings": {
          const scope = command.scope as SettingsScope;
          const keys = command.keys as string[];
          const known = new Set(SETTINGS_CATALOG.map((item) => item.key));
          const unknown = keys.filter((key) => !known.has(key));
          if (unknown.length)
            throw Object.assign(new Error("Unknown setting key"), {
              code: "invalid_input",
              details: unknown,
            });
          const current = this.store.settings.read(scope);
          const version = this.saveSettings(
            scope,
            command.expectedVersion as number,
            removeSettings(current.data, keys),
          );
          return {
            ok: true,
            result: { kind: "settings_updated", scope, version },
          };
        }
        case "set_title": {
          if (
            !String(command.hostGeneration).startsWith(
              `loom-${this.config.instance}#`,
            )
          )
            throw new Error("Terminal belongs to another instance");
          await this.adapters.paneHost.setTitle({
            hostGeneration: String(command.hostGeneration),
            target: command.target as Parameters<
              Adapters["paneHost"]["setTitle"]
            >[0]["target"],
            title: String(command.title),
          });
          await this.inventory.refresh();
          return { ok: true, result: { kind: "titled" } };
        }
        case "open_task_terminal": {
          const taskId = command.taskId as TaskId;
          const state = this.store.loadTaskState(taskId);
          const repo = this.store
            .repos()
            .find((repo) => repo.id === state.task.repoId);
          if (!repo) throw new Error("Task project is unavailable");
          const terminal = await openTaskTerminal(state, repo, this.adapters);
          await this.inventory.refresh();
          return {
            ok: true,
            result: { kind: "task_terminal", taskId, ...terminal },
          };
        }
        case "open_workbench_terminal":
        case "open_pane_session": {
          const scratchTarget =
            command.kind === "open_workbench_terminal" && command.target
              ? paneIdentity.parse(command.target)
              : undefined;
          if (
            scratchTarget &&
            !scratchTarget.hostGeneration.startsWith(
              `loom-${this.config.instance}#`,
            )
          )
            throw new Error("Pane belongs to another instance");
          const scratchPane = scratchTarget
            ? await this.adapters.paneHost.getPane(scratchTarget)
            : null;
          if (
            scratchTarget &&
            (!scratchPane ||
              scratchPane.dead ||
              scratchPane.ref.windowId !== scratchTarget.windowId)
          )
            throw new Error("Pane is missing, dead or stale");
          if (
            command.kind === "open_workbench_terminal" &&
            command.split &&
            !scratchTarget
          )
            throw new Error("Split requires a target pane");
          // A new space opens at the selected project's root, so its shell is in the repo.
          const newSpace =
            command.kind === "open_workbench_terminal" && !scratchTarget
              ? (command.workspace as string | undefined)
              : undefined;
          const selectedRepoId = newSpace ? this.store.selectedRepo() : null;
          const spaceRoot = selectedRepoId
            ? this.repoById(selectedRepoId).root
            : null;
          const ref =
            command.kind === "open_workbench_terminal"
              ? await this.adapters.paneHost.createScratch({
                  workspaceId:
                    newSpace ?? scratchPane?.workspaceId ?? "loom-workbench",
                  target: scratchTarget,
                  split: command.split as "right" | "below" | undefined,
                  createWorkspace: true,
                  key: command.key as string,
                  label: (command.label as string | undefined) ?? "Terminal",
                  cwd:
                    spaceRoot ??
                    scratchPane?.startCwd ??
                    (homedir() as WorktreePath),
                  executable: process.env.SHELL || "/bin/sh",
                  args: ["-l"],
                  env: runEnvironment(process.env, {}),
                })
              : paneIdentity.parse(command.target);
          if (command.kind !== "open_pane_session")
            await this.inventory.refresh();
          if (!ref.hostGeneration.startsWith(`loom-${this.config.instance}#`))
            throw new Error("Pane belongs to another instance");
          const pane = await this.adapters.paneHost.getPane(ref);
          if (!pane || pane.dead || pane.ref.windowId !== ref.windowId)
            throw new Error("Pane is missing, dead or stale");
          return {
            ok: true,
            result: {
              kind: "attach_session",
              target: {
                identity: "pane",
                target: pane.ref,
                attach: {
                  kind: "pane_host",
                  argv: this.adapters.paneHost.attachArgs(pane.ref),
                  cwd: pane.startCwd,
                  env: {},
                },
                pane: {
                  ...pane.ref,
                  dead: false,
                  exitStatus: null,
                  attachedClients: 0,
                  size: null,
                  observedAt: this.now(),
                },
              },
            },
          };
        }
        case "close_terminal": {
          const ref = paneIdentity.parse(command.target);
          if (!ref.hostGeneration.startsWith(`loom-${this.config.instance}#`))
            throw new Error("Pane belongs to another instance");
          if (
            ref.sessionName.startsWith("loom-lead-") ||
            ["loom-lead", "loom-main"].includes(ref.sessionName)
          )
            throw new Error(
              "Pinned agents are stopped through their agent controls",
            );
          // A task's supervisor would recover an unannounced terminal death. Require
          // its normal stop control instead of reporting a close that immediately reopens.
          const scope = command.scope ?? "pane";
          const inScope = (pane: {
            sessionName: string;
            windowId: string;
            paneId: string;
          }) =>
            pane.sessionName === ref.sessionName &&
            (scope === "session" ||
              (pane.windowId === ref.windowId &&
                (scope === "window" || pane.paneId === ref.paneId)));
          const active = this.store
            .tasks()
            .flatMap((task) => this.store.runs(task.id))
            .find(
              (run) =>
                !run.endedAt &&
                run.pane &&
                run.pane.hostGeneration === ref.hostGeneration &&
                inScope(run.pane),
            );
          if (active)
            throw new Error(
              "Stop the running task before closing its agent terminal",
            );
          if (scope === "session")
            await this.adapters.paneHost.closeSession(ref);
          else if (scope === "window")
            await this.adapters.paneHost.closeWindow(ref);
          else await this.adapters.paneHost.closeTerminal(ref);
          if (await this.adapters.paneHost.getPane(ref))
            throw new Error("Terminal closure was not confirmed");
          await this.inventory.refresh();
          return { ok: true, result: { kind: "terminal_closed", target: ref } };
        }
        case "create_scratch": {
          const state = this.store.loadTaskState(command.taskId as TaskId);
          if (!state.worktree?.paneWorkspaceId)
            throw new Error("Task has no existing pane workspace");
          const ref = await this.adapters.paneHost.createScratch({
            workspaceId: state.worktree.paneWorkspaceId,
            createWorkspace: true,
            cwd: state.worktree.path,
            key: command.key as string,
            label: command.label as string | undefined,
            executable: process.env.SHELL || "/bin/sh",
            args: ["-l"],
            env: runEnvironment(process.env, {}),
          });
          await this.inventory.refresh();
          const pane = this.inventory.rows.find((p) => p.id === paneKey(ref));
          if (!pane)
            throw new Error("Scratch created but inventory unavailable");
          return { ok: true, result: { kind: "scratch_created", pane } };
        }
        case "get_briefs":
          return {
            ok: true,
            result: { kind: "briefs", state: this.store.briefs.state() },
          };
        case "get_brief": {
          const run = this.store.briefs.get(command.id as string);
          if (!run) throw new Error("Unknown daily brief");
          return { ok: true, result: { kind: "brief", run } };
        }
        case "run_brief":
          return {
            ok: true,
            result: {
              kind: "brief",
              run: this.briefs.run("manual", command.id as string),
            },
          };
        case "set_brief_schedule":
          this.store.briefs.setEnabled(command.enabled as boolean);
          return {
            ok: true,
            result: { kind: "briefs", state: this.store.briefs.state() },
          };
        case "select_repo": {
          this.store.selectRepo(command.repoId as string);
          this.publishRepos();
          return {
            ok: true,
            result: { kind: "repo_selected", repoId: command.repoId },
          };
        }
        case "add_repo": {
          const repo = await registerRepo(
            this.store,
            command.root as string,
            command.github as string,
            command.baseBranch as string | undefined,
            this.effectiveSettings().repository.baseBranch,
            this.now(),
          );
          this.store.selectRepo(repo.id);
          const lead = this.leadFor(repo.id);
          if (!lead.sessionId) {
            await lead.load();
            await lead.recover();
          }
          this.publishRepos();
          this.publishSettings();
          await this.publishLead();
          return { ok: true, result: { kind: "repo_added", repoId: repo.id } };
        }
        case "open_lead_session": {
          const target = await this.leadFor(command.repoId as string).open();
          await this.publishLead();
          await this.inventory.refresh();
          return { ok: true, result: { kind: "attach_session", target } };
        }
        case "stop_lead_session": {
          await this.leadFor(command.repoId as string).stop();
          await this.publishLead();
          return { ok: true, result: { kind: "lead_stopped" } };
        }
        case "steer_lead_message": {
          const lead = this.leadFor(command.repoId as string);
          const result = await lead.steerMessage(
            command.clientMessageId as string,
          );
          this.conversationViews.hint(lead.sessionId);
          return { ok: true, result: { kind: "lead_message", ...result } };
        }
        case "interrupt_lead": {
          await this.leadFor(command.repoId as string).interrupt();
          return { ok: true, result: { kind: "lead_interrupted" } };
        }
        case "stage_attachment": {
          const attachment = await this.attachments.stage(
            command.name as string,
            command.mediaType as string,
            command.dataBase64 as string,
          );
          return {
            ok: true,
            result: { kind: "attachment_staged", ...attachment },
          };
        }
        case "send_lead_message": {
          const lead = this.leadFor(command.repoId as string);
          const attachments = await this.attachments.resolve(
            (command.attachmentIds ?? []) as string[],
          );
          const result = await lead.sendMessage(
            command.clientMessageId as string,
            withAttachedFiles(command.text as string, attachments),
            (command.when ?? "now") as "now" | "after_turn",
          );
          this.conversationViews.hint(lead.sessionId);
          return { ok: true, result: { kind: "lead_message", ...result } };
        }
        case "answer_lead_prompt": {
          const lead = this.leadFor(command.repoId as string);
          await lead.answerPrompt(
            command.expectedDialog as { requestId?: string; at: string },
            command.choice as number | "enter" | "escape",
          );
          this.conversationViews.hint(lead.sessionId);
          return { ok: true, result: { kind: "lead_prompt_answered" } };
        }
        case "create_task": {
          const state = this.createTask({
            repoId: command.repoId as RepoId,
            title: command.title as string,
            name: (command.name ?? null) as string | null,
            description: command.description as string,
            summary: (command.summary ?? null) as string | null,
            providers: (command.providers ?? null) as ProviderRules | null,
            requirePlanApproval: (command.requirePlanApproval ?? null) as
              | boolean
              | null,
            blockedBy: (command.blockedBy ?? []) as TaskId[],
            budgetMinutes: (command.budgetMinutes ?? null) as number | null,
            size: (command.size ?? null) as "small" | "normal" | null,
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
          let human = command.command;
          if (human.type === "send_message" && human.attachmentIds?.length) {
            const attachments = await this.attachments.resolve(
              human.attachmentIds,
            );
            const runId = human.runId;
            const run = this.store
              .runs(command.taskId)
              .find((value) => value.id === runId);
            if (!run) throw new PreconditionFailed("Choose a live Loom run");
            const images = attachments.filter((value) =>
              value.mediaType.startsWith("image/"),
            );
            const paths =
              run.provider === "codex"
                ? attachments.filter(
                    (value) => !value.mediaType.startsWith("image/"),
                  )
                : attachments;
            human = {
              ...human,
              text: withAttachedFiles(human.text, paths),
              attachmentIds:
                run.provider === "codex"
                  ? images.map((value) => value.path)
                  : [],
            };
          }
          const inputId = this.submitHuman(command.taskId, human);
          const disposition = await this.decision(command.taskId, inputId);
          if (!disposition.accepted)
            return { ok: false, error: disposition.error };
          return { ok: true, result: { kind: "human", inputId } };
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
      const typed = error as Error & { code?: string; details?: string[] };
      return {
        ok: false,
        error: {
          code:
            typed.code === "conflict"
              ? "conflict"
              : typed.code === "invalid_input"
                ? "invalid_input"
                : error instanceof PreconditionFailed
                  ? "guard_failed"
                  : "internal",
          message: error instanceof Error ? error.message : String(error),
          details: typed.details ?? [],
        },
      };
    }
  }
}
