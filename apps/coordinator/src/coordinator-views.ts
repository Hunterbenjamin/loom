// Disposable protocol projections and their refresh/subscription lifecycle.
import type {
  IsoTime,
  ReconcileResult,
  Repo,
  RepoId,
  TaskId,
} from "@loom/core";
import type { Change, Subscription } from "@loom/protocol";
import { ConversationViews } from "./conversations.js";
import type { Executor } from "./executor.js";
import type { LeadSession } from "./lead.js";
import type { Loop } from "./loop.js";
import type { PullRequestCache } from "./observe.js";
import { PaneInventory, paneKey } from "./pane-inventory.js";
import { PullRequestViews } from "./pull-requests.js";
import type { ProtocolServer } from "./server.js";
import type { CoordinatorSettings } from "./settings.js";
import {
  changesRow,
  PublishedRows,
  type Row,
  taskRows,
  type ViewDeps,
} from "./views.js";

interface CoordinatorViewDeps extends ViewDeps {
  settings: CoordinatorSettings;
  leads: Map<string, LeadSession>;
  leadFor(repoId: string): LeadSession;
  repoById(repoId: RepoId): Repo;
  loop: Loop;
  executor: Executor;
  pullRequests: PullRequestCache;
  protocol(): ProtocolServer;
  now(): IsoTime;
  after(ms: number, callback: () => void): () => void;
  log(message: string): void;
  reportAdapterFailure(operation: string, error: unknown): void;
}

const TERMINAL = ["done", "canceled"];

export class CoordinatorViews {
  readonly prViews: PullRequestViews;
  readonly conversationViews: ConversationViews;
  readonly inventory: PaneInventory;
  readonly published = new PublishedRows();
  private readonly publishFailures = new Map<TaskId, Set<string>>();
  private readonly diffScopes = new Set<string>();
  private pollingLead = false;

  constructor(private readonly deps: CoordinatorViewDeps) {
    this.prViews = new PullRequestViews({
      viewedFiles: (repo, number, head) =>
        this.deps.store.pullRequestViewedFiles(repo, number, head),
      saveReviewState: (command) =>
        this.deps.store.savePullRequestReviewState(command),
      preferences: (repo, number) =>
        this.deps.store.pullRequestPreferences(repo, number),
      log: (message) => this.deps.log(message),
      github: this.deps.adapters.github,
      repo: (id) => this.deps.repoById(id),
      tasks: () => this.deps.store.tasks(),
      replace: (owner, rows) =>
        this.deps.protocol().publish(this.published.replace(owner, null, rows)),
      after: this.deps.after,
      action: (command) => this.deps.executor.pullRequest(command),
      linksChanged: async (repo) => {
        for (const task of this.deps.store.tasks())
          if (task.repoId === repo.id)
            this.deps.protocol().publish(await this.refreshTask(task.id));
      },
      merged: (repo, head) => {
        for (const task of this.deps.store.tasks())
          if (
            task.repoId === repo.id &&
            task.branch === head &&
            task.stage !== "done"
          ) {
            this.deps.pullRequests.forget(repo.github, head);
            this.deps.loop.enqueue(task.id);
          }
      },
      changed: (repo) => {
        for (const task of this.deps.store.tasks())
          if (
            task.repoId === repo.id &&
            task.branch &&
            !TERMINAL.includes(task.stage)
          ) {
            this.deps.pullRequests.forget(repo.github, task.branch);
            this.deps.loop.enqueue(task.id);
          }
      },
      onError: (error) =>
        this.deps.log(
          `Could not refresh pull requests: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    this.conversationViews = new ConversationViews({
      store: this.deps.store,
      adapters: this.deps.adapters,
      lead: (repoId) => this.deps.leadFor(repoId),
      now: () => this.deps.now(),
      after: this.deps.after,
      replace: (owner, rows) =>
        this.deps.protocol().publish(this.published.replace(owner, null, rows)),
      log: (message) => this.deps.log(message),
    });
    this.inventory = new PaneInventory(
      this.deps.adapters.paneHost,
      this.deps.adapters.git,
      () => ({
        states: this.deps.store
          .tasks()
          .map((t) => this.deps.store.loadTaskState(t.id)),
        repos: this.deps.store.repos(),
        research: this.deps.store.research.list({ archived: "all" }),
        now: this.deps.now(),
        leadPanes: new Set(
          [...this.deps.leads.entries()].flatMap(([id, lead]) =>
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
        this.deps.protocol().publish(
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
      (operation, error) => this.deps.reportAdapterFailure(operation, error),
    );
  }

  private async leadRows(): Promise<Row[]> {
    return Promise.all(
      this.deps.store.repos().map(async (repo) => ({
        collection: "lead" as const,
        key: repo.id,
        value: await this.deps.leadFor(repo.id).state(),
      })),
    );
  }
  private projectRows(): Row[] {
    return [
      {
        collection: "project",
        key: "project",
        value: { id: "project", repoId: this.deps.store.selectedRepo() },
      },
    ];
  }
  publishSettings(): void {
    this.deps
      .protocol()
      .publish(
        this.published.replace("settings", null, this.deps.settings.rows()),
      );
  }
  publishRepos(): void {
    this.deps.protocol().publish([
      ...this.published.replace(
        "repos",
        null,
        this.deps.store
          .repos()
          .map((repo) => ({ collection: "repo", key: repo.id, value: repo })),
      ),
      ...this.published.replace("project", null, this.projectRows()),
    ]);
  }
  publishCommittedTask(taskId: TaskId, result: ReconcileResult): void {
    void this.publishTask(taskId, result).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const failures = this.publishFailures.get(taskId) ?? new Set<string>();
      // Log the error only once per (task, error message) pair
      if (!failures.has(errorMessage)) {
        failures.add(errorMessage);
        this.publishFailures.set(taskId, failures);
        this.deps.log(
          `Could not publish ${taskId}: ${errorMessage} (further failures for this task/cause suppressed)`,
        );
      }
    });
  }

  clearFailures(): void {
    this.publishFailures.clear();
  }

  private async publishTask(
    taskId: TaskId,
    _result: ReconcileResult,
  ): Promise<void> {
    if (!this.deps.protocol().clients && !this.published.rows().length) return;
    const changes = await this.refreshTask(taskId);
    this.deps.protocol().publish(changes);
    this.publishFailures.delete(taskId);
    await this.inventory.refresh();
  }

  viewDeps(): ViewDeps {
    return {
      store: this.deps.store,
      adapters: this.deps.adapters,
      recipes: this.deps.recipes,
      config: this.deps.config,
      now: () => this.deps.now(),
      reportAdapterFailure: (operation, error) =>
        this.deps.reportAdapterFailure(operation, error),
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

  async publishLead(): Promise<void> {
    if (this.pollingLead) return;
    this.pollingLead = true;
    try {
      const changes = this.published.replace(
        "lead",
        null,
        await this.leadRows(),
      );
      this.deps.protocol().publish(changes);
      if (changes.length) void this.inventory.refresh();
    } catch {
      this.deps.log("Could not refresh Main status");
    } finally {
      this.pollingLead = false;
    }
  }

  async refreshAll(scope: readonly Subscription[]): Promise<void> {
    await this.ensure(scope);
    this.published.replace("lead", null, await this.leadRows());
    this.published.replace("project", null, this.projectRows());
    this.published.replace("settings", null, this.deps.settings.rows());
    this.published.replace(
      "repos",
      null,
      this.deps.store.repos().map((repo) => ({
        collection: "repo" as const,
        key: repo.id,
        value: repo,
      })) as Row[],
    );
    for (const task of this.deps.store.tasks()) await this.refreshTask(task.id);
  }

  async ensure(scope: readonly Subscription[]): Promise<void> {
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
      this.deps
        .protocol()
        .publish(
          this.published.replace(
            `diff:${key}`,
            subscription.taskId,
            diff ? [diff] : [],
          ),
        );
    }
  }
}
