// Disposable GitHub projections. Windows own subscriptions; GitHub owns every PR fact.
import type { GitHubAdapter, Repo, RepoId, Task } from "@loom/core";
import {
  type PullRequestCommand,
  type PullRequestDetailRow,
  type PullRequestRow,
  pullRequestDetailRow,
  pullRequestKey,
  pullRequestRow,
  type Subscription,
} from "@loom/protocol";
import type { Row } from "./views.js";

type ListScope = Extract<Subscription, { kind: "pull_requests" }>;
type DetailScope = Extract<Subscription, { kind: "pull_request" }>;
type PrScope = ListScope | DetailScope;
const scopeKey = (s: PrScope) => JSON.stringify(s);
const isPrScope = (s: Subscription): s is PrScope =>
  s.kind === "pull_requests" || s.kind === "pull_request";

export interface PullRequestViewsDeps {
  github: GitHubAdapter;
  repo(id: RepoId): Repo;
  tasks(): Task[];
  replace(owner: string, rows: Row[]): void;
  after(ms: number, callback: () => void): () => void;
  action(command: PullRequestCommand): Promise<void>;
  changed(repo: Repo): void;
  onError(error: unknown): void;
}

export class PullRequestViews {
  private readonly active = new Map<string, PrScope>();
  private readonly timers = new Map<string, () => void>();
  private readonly loaded = new Set<string>();
  private readonly lists = new Map<RepoId, Map<number, PullRequestRow>>();
  private readonly details = new Map<string, PullRequestDetailRow>();
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(private readonly deps: PullRequestViewsDeps) {}

  /** The union of live window scopes, recalculated on hello, subscribe, disconnect and timeout. */
  subscriptions(scopes: readonly Subscription[]): void {
    const next = new Map(scopes.filter(isPrScope).map((s) => [scopeKey(s), s]));
    for (const [key, cancel] of this.timers) {
      if (next.has(key)) continue;
      cancel();
      this.timers.delete(key);
    }
    for (const key of this.active.keys())
      if (!next.has(key)) this.loaded.delete(key);
    for (const key of next.keys())
      if (!this.active.has(key)) this.loaded.delete(key);
    this.active.clear();
    for (const [key, scope] of next) {
      this.active.set(key, scope);
      if (!this.timers.has(key)) this.schedule(key, scope);
    }
  }

  private schedule(key: string, scope: PrScope): void {
    if (this.stopped || !this.active.has(key)) return;
    const cancel = this.deps.after(
      scope.kind === "pull_requests" ? 60_000 : 30_000,
      () => {
        // Keep the key while a read is in flight, so another window cannot start a second poll.
        void this.serial(async () => {
          if (!this.stopped && this.active.has(key)) await this.read(scope);
        })
          .catch(this.deps.onError)
          .finally(() => {
            if (this.timers.get(key) !== cancel) return;
            this.timers.delete(key);
            this.schedule(key, scope);
          });
      },
    );
    this.timers.set(key, cancel);
  }

  ensure(scopes: readonly Subscription[]): Promise<void> {
    const requested = scopes.filter(isPrScope);
    if (!requested.length) return Promise.resolve();
    return this.serial(async () => {
      for (const scope of requested) {
        if (this.loaded.has(scopeKey(scope))) continue;
        // A GitHub outage must not prevent the entire window's handshake or subscription ack.
        try {
          await this.read(scope);
        } catch (error) {
          this.deps.onError(error);
        }
      }
    });
  }

  command(command: PullRequestCommand): Promise<void> {
    return this.serial(async () => {
      const repo = this.deps.repo(command.repoId);
      let actionError: unknown;
      try {
        await this.deps.action(command);
      } catch (error) {
        actionError = error;
      }
      // Also refresh refusals and uncertain writes. Never automatically replay a command.
      this.deps.changed(repo);
      const scopes = new Map<string, PrScope>();
      const list: ListScope = {
        kind: "pull_requests",
        repoId: repo.id,
        state:
          command.kind === "refresh_pull_requests" ? command.state : "open",
      };
      scopes.set(scopeKey(list), list);
      for (const s of this.active.values())
        if (s.repoId === repo.id) scopes.set(scopeKey(s), s);
      if (command.kind !== "refresh_pull_requests") {
        const detail: DetailScope = {
          kind: "pull_request",
          repoId: repo.id,
          number: command.number,
        };
        scopes.set(scopeKey(detail), detail);
      }
      let refreshError: unknown;
      for (const scope of scopes.values()) {
        try {
          await this.read(scope);
        } catch (error) {
          refreshError = error;
          this.deps.onError(error);
        }
      }
      if (actionError) throw actionError;
      if (refreshError) throw refreshError;
    });
  }

  private taskId(repoId: RepoId, head: string) {
    const matches = this.deps
      .tasks()
      .filter((task) => task.repoId === repoId && task.branch === head);
    return matches.length === 1 ? (matches[0]?.id ?? null) : null;
  }

  /** Task creation/branch changes update links without manufacturing a GitHub observation. */
  relink(): void {
    for (const [key, previous] of this.details) {
      const taskId = this.taskId(previous.repoId, previous.detail.head);
      if (taskId === previous.taskId) continue;
      const value = {
        ...previous,
        taskId,
      };
      this.details.set(key, value);
      this.deps.replace(`pull_request:${key}`, [
        { collection: "pull_request_detail", key, value },
      ]);
    }
    for (const [repoId, rows] of this.lists) {
      let changed = false;
      for (const [number, row] of rows) {
        const taskId = this.taskId(repoId, row.head);
        if (taskId === row.taskId) continue;
        rows.set(number, { ...row, taskId });
        changed = true;
      }
      if (changed) this.publishList(repoId);
    }
  }

  private publishList(repoId: RepoId): void {
    const rows = [...(this.lists.get(repoId)?.values() ?? [])].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number,
    );
    this.deps.replace(
      `pull_requests:${repoId}`,
      rows.map((value) => ({
        collection: "pull_request",
        key: pullRequestKey(repoId, value.number),
        value,
      })),
    );
  }

  private async read(scope: PrScope): Promise<void> {
    const repo = this.deps.repo(scope.repoId);
    const rows = this.lists.get(repo.id) ?? new Map<number, PullRequestRow>();
    if (scope.kind === "pull_requests") {
      const list = await this.deps.github.listPullRequests(
        repo.github,
        scope.state,
      );
      const parsed = list.map((pr) =>
        pullRequestRow.parse({
          ...pr,
          repoId: repo.id,
          taskId: this.taskId(repo.id, pr.head),
        }),
      );
      for (const [number, previous] of rows)
        if (previous.state === scope.state) rows.delete(number);
      for (const row of parsed) rows.set(row.number, row);
    } else {
      const detail = await this.deps.github.readPullRequest(
        repo.github,
        scope.number,
      );
      const patch = await this.deps.github.readPullRequestPatch(
        repo.github,
        scope.number,
      );
      const after = await this.deps.github.readPullRequest(
        repo.github,
        scope.number,
      );
      if (
        detail.headSha !== after.headSha ||
        detail.base !== after.base ||
        detail.updatedAt !== after.updatedAt
      )
        throw new Error(
          "PR changed while reading its patch; refresh to read a consistent head",
        );
      const value = pullRequestDetailRow.parse({
        repoId: repo.id,
        number: scope.number,
        taskId: this.taskId(repo.id, after.head),
        detail: after,
        patch,
      });
      const key = pullRequestKey(repo.id, scope.number);
      this.details.set(key, value);
      this.deps.replace(`pull_request:${key}`, [
        { collection: "pull_request_detail", key, value },
      ]);
      const {
        body: _body,
        mergedAt: _at,
        mergeCommitSha: _sha,
        commits: _commits,
        checkRuns: _checks,
        additions: _add,
        deletions: _del,
        changedFiles: _files,
        ...summary
      } = after;
      rows.set(
        scope.number,
        pullRequestRow.parse({
          ...summary,
          repoId: repo.id,
          taskId: value.taskId,
        }),
      );
    }
    this.lists.set(repo.id, rows);
    this.publishList(repo.id);
    this.loaded.add(scopeKey(scope));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.active.clear();
    await this.tail;
  }
}
