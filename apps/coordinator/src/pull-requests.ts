// Disposable GitHub projections. Windows own subscriptions; GitHub owns every PR fact.
import type {
  GitHubAdapter,
  PullRequestDetail,
  PullRequestPatch,
  Repo,
  RepoId,
  Task,
} from "@loom/core";
import {
  type PullRequestCommand,
  type PullRequestDetailRow,
  type PullRequestRow,
  pullRequestCommitDiff,
  pullRequestDetailRow,
  type pullRequestDiffRead,
  pullRequestFileContents,
  pullRequestKey,
  pullRequestListKey,
  type pullRequestReviewChange,
  pullRequestRow,
  type Subscription,
} from "@loom/protocol";
import type { z } from "zod";
import type { Row } from "./views.js";

type ListScope = Extract<Subscription, { kind: "pull_requests" }>;
type DetailScope = Extract<Subscription, { kind: "pull_request" }>;
type PrScope = ListScope | DetailScope;
const scopeKey = (s: PrScope) =>
  s.kind === "pull_requests"
    ? pullRequestListKey(s.repoId, s.state)
    : pullRequestKey(s.repoId, s.number);
const isPrScope = (s: Subscription): s is PrScope =>
  s.kind === "pull_requests" || s.kind === "pull_request";

export interface PullRequestViewsDeps {
  github: GitHubAdapter;
  repo(id: RepoId): Repo;
  tasks(): Task[];
  preferences?(
    repo: RepoId,
    number: number,
  ): { pinned: boolean; taskId: Task["id"] | null };
  viewedFiles?(
    repo: RepoId,
    number: number,
    headSha: string,
  ): PullRequestDetailRow["viewedFiles"];
  saveReviewState?(command: z.output<typeof pullRequestReviewChange>): void;
  replace(owner: string, rows: Row[]): void;
  after(ms: number, callback: () => void): () => void;
  action(command: PullRequestCommand): Promise<void>;
  changed(repo: Repo): void;
  linksChanged?(repo: Repo): Promise<void>;
  merged?(repo: Repo, head: string): void;
  onError(error: unknown): void;
  log?(message: string): void;
}

export class PullRequestViews {
  private readonly active = new Map<string, PrScope>();
  private readonly timers = new Map<string, () => void>();
  private readonly loaded = new Set<string>();
  private readonly lists = new Map<RepoId, Map<number, PullRequestRow>>();
  private readonly details = new Map<string, PullRequestDetailRow>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly commands = new Map<string, Promise<void>>();
  private readonly listStates = new Set<string>();
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
        void this.refresh(scope)
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
    if (this.stopped) return Promise.resolve();
    for (const scope of scopes.filter(isPrScope)) {
      if (!this.loaded.has(scopeKey(scope)))
        void this.refresh(scope).catch(this.deps.onError);
    }
    // Handshakes and subscription acknowledgments only wait for the cached projection.
    return Promise.resolve();
  }

  private publishLoading(scope: ListScope, loading: boolean): void {
    const key = pullRequestListKey(scope.repoId, scope.state);
    this.listStates.add(key);
    this.deps.replace(`pull_requests_state:${key}`, [
      {
        collection: "pull_requests",
        key,
        value: { repoId: scope.repoId, state: scope.state, loading },
      },
    ]);
  }

  private refresh(scope: PrScope, force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const key = scopeKey(scope);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const initial = scope.kind === "pull_requests" && !this.listStates.has(key);
    if (initial) this.publishLoading(scope, true);
    const result = Promise.resolve()
      .then(() => this.read(scope, force))
      .finally(() => {
        this.reads.delete(key);
        if (initial) this.publishLoading(scope, false);
      });
    this.reads.set(key, result);
    return result;
  }

  command(command: PullRequestCommand): Promise<void> {
    const key =
      command.kind === "refresh_pull_requests"
        ? pullRequestListKey(command.repoId, command.state)
        : pullRequestKey(command.repoId, command.number);
    const result = (this.commands.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const repo = this.deps.repo(command.repoId);
        let actionError: unknown;
        try {
          await this.deps.action(command);
        } catch (error) {
          actionError = error;
        }
        if (
          command.kind === "pin_pull_request" ||
          command.kind === "link_pull_request"
        ) {
          this.relink();
          if (command.kind === "link_pull_request")
            await this.deps.linksChanged?.(repo);
          if (actionError) throw actionError;
          return;
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
        await Promise.all(
          [...scopes.values()].map(async (scope) => {
            try {
              // A read started before the action cannot confirm that action's outcome.
              await this.reads.get(scopeKey(scope))?.catch(() => {});
              await this.refresh(scope, true);
            } catch (error) {
              refreshError = error;
              this.deps.onError(error);
            }
          }),
        );
        if (actionError) throw actionError;
        if (refreshError) throw refreshError;
      })
      .finally(() => {
        if (this.commands.get(key) === result) this.commands.delete(key);
      });
    this.commands.set(key, result);
    return result;
  }

  async saveReview(
    command: z.output<typeof pullRequestReviewChange>,
  ): Promise<void> {
    const repo = this.deps.repo(command.repoId);
    const pr = await this.deps.github.readPullRequest(
      repo.github,
      command.number,
    );
    if (pr.headSha !== command.change.headSha)
      throw new Error("PR head changed; refresh before marking Reviewed");
    for (const file of command.change.viewed ?? []) {
      if (
        file.headSha !== pr.headSha ||
        file.fileId !== file.path ||
        !pr.files.some((f) => f.path === file.path)
      )
        throw new Error("Viewed file must belong to this PR head");
    }
    if (!this.deps.saveReviewState)
      throw new Error("Review state is unavailable");
    this.deps.saveReviewState(command);
    this.relink();
  }

  async readDiff(command: z.output<typeof pullRequestDiffRead>) {
    const repo = this.deps.repo(command.repoId);
    const pr = await this.deps.github.readPullRequest(
      repo.github,
      command.number,
      { cached: true },
    );
    if (pr.headSha !== command.headSha || pr.baseSha !== command.baseSha)
      throw new Error("PR head or base changed; refresh the diff");
    if (
      command.commitSha &&
      !pr.commits.some((c) => c.sha === command.commitSha)
    )
      throw new Error("Commit is not in this pull request");
    const commit = command.commitSha
      ? pullRequestCommitDiff.parse(
          await this.deps.github.readPullRequestCommit(
            repo.github,
            command.number,
            command.commitSha,
          ),
        )
      : null;
    if (commit && commit.patch.headSha !== command.commitSha)
      throw new Error("Commit diff SHA mismatch");
    if (command.kind === "fetch_pull_request_commit") {
      if (!commit) throw new Error("Commit diff SHA mismatch");
      return { kind: "pull_request_commit" as const, diff: commit };
    }
    if (!(commit?.files ?? pr.files).some((f) => f.path === command.path))
      throw new Error("File is not in this diff");
    const contents = pullRequestFileContents.parse(
      await this.deps.github.readPullRequestFile(
        repo.github,
        commit?.patch ?? pr,
        command.path,
        command.ignoreWhitespace,
      ),
    );
    return { kind: "pull_request_file" as const, contents };
  }

  private taskId(repoId: RepoId, head: string, number: number) {
    const linked = this.deps.preferences?.(repoId, number)?.taskId;
    if (
      linked &&
      this.deps
        .tasks()
        .some((task) => task.repoId === repoId && task.id === linked)
    )
      return linked;
    const matches = this.deps
      .tasks()
      .filter((task) => task.repoId === repoId && task.branch === head);
    return matches.length === 1 ? (matches[0]?.id ?? null) : null;
  }

  /** Task creation/branch changes update links without manufacturing a GitHub observation. */
  relink(): void {
    for (const [key, previous] of this.details) {
      const taskId = this.taskId(
        previous.repoId,
        previous.detail.head,
        previous.number,
      );
      const pinned =
        this.deps.preferences?.(previous.repoId, previous.number)?.pinned ??
        false;
      const viewedFiles =
        this.deps.viewedFiles?.(
          previous.repoId,
          previous.number,
          previous.detail.headSha,
        ) ?? [];
      if (
        taskId === previous.taskId &&
        pinned === previous.pinned &&
        JSON.stringify(viewedFiles) === JSON.stringify(previous.viewedFiles)
      )
        continue;
      const value = {
        ...previous,
        viewedFiles,
        pinned,
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
        const taskId = this.taskId(repoId, row.head, row.number);
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

  private async read(scope: PrScope, force: boolean): Promise<void> {
    const repo = this.deps.repo(scope.repoId);

    if (scope.kind === "pull_requests") {
      const list = await this.timed("list", repo, scope.state, () =>
        this.deps.github.listPullRequests(repo.github, scope.state),
      );
      const parsed = list.map((pr) =>
        pullRequestRow.parse({
          ...pr,
          repoId: repo.id,
          taskId: this.taskId(repo.id, pr.head, pr.number),
        }),
      );
      const rows = this.lists.get(repo.id) ?? new Map<number, PullRequestRow>();
      this.lists.set(repo.id, rows);
      for (let i = 0; i < parsed.length; i++) {
        const row = parsed[i];
        if (!row) continue;
        const previous = rows.get(row.number);
        if (row.state === "merged" && previous?.state !== "merged")
          this.deps.merged?.(repo, row.head);
        if (
          previous &&
          JSON.stringify(previous) ===
            JSON.stringify({ ...row, observedAt: previous.observedAt })
        )
          parsed[i] = previous;
      }
      for (const [number, previous] of rows)
        if (previous.state === scope.state) rows.delete(number);
      for (const row of parsed) rows.set(row.number, row);
    } else {
      const key = pullRequestKey(repo.id, scope.number);
      const previous = this.details.get(key);
      const known =
        this.lists.get(repo.id)?.get(scope.number) ?? previous?.detail;
      const readPatch = (
        range: Pick<PullRequestDetail, "baseSha" | "headSha">,
      ) => {
        if (
          previous?.patch?.headSha === range.headSha &&
          previous.patch.baseSha === range.baseSha
        )
          return Promise.resolve(previous.patch);
        return this.timed("diff", repo, scope.number, () =>
          this.deps.github.readPullRequestPatch(
            repo.github,
            scope.number,
            range,
          ),
        );
      };
      // Attach both handlers immediately: either network read can fail or finish first.
      const pendingPatch = known
        ? readPatch(known).then(
            (patch) => ({ patch, error: null }),
            (error) => ({ patch: null, error }),
          )
        : null;
      let after: PullRequestDetail;
      try {
        after = await this.timed("detail/checks", repo, scope.number, () =>
          this.deps.github.readPullRequest(repo.github, scope.number, {
            cached:
              !force &&
              (!previous ||
                !known ||
                (previous.detail.headSha === known.headSha &&
                  previous.detail.baseSha === known.baseSha &&
                  previous.detail.updatedAt === known.updatedAt)),
          }),
        );
      } catch (error) {
        await pendingPatch;
        throw error;
      }
      const matches = (patch: PullRequestPatch | null | undefined) =>
        patch?.headSha === after.headSha && patch.baseSha === after.baseSha;
      const value = pullRequestDetailRow.parse({
        repoId: repo.id,
        number: scope.number,
        taskId: this.taskId(repo.id, after.head, after.number),
        detail: after,
        patch: matches(previous?.patch) ? previous?.patch : null,
        patchLoading: !matches(previous?.patch),
        patchError: null,
        behindBy:
          previous?.detail.headSha === after.headSha &&
          previous.detail.baseSha === after.baseSha
            ? previous.behindBy
            : null,
      });
      if (after.state === "merged" && previous?.detail.state !== "merged")
        this.deps.merged?.(repo, after.head);
      const publish = () => {
        value.viewedFiles =
          this.deps.viewedFiles?.(repo.id, after.number, after.headSha) ?? [];
        value.pinned =
          this.deps.preferences?.(repo.id, after.number)?.pinned ?? false;
        value.taskId = this.taskId(repo.id, after.head, after.number);
        this.details.set(key, { ...value });
        this.deps.replace(`pull_request:${key}`, [
          { collection: "pull_request_detail", key, value: { ...value } },
        ]);
      };
      publish();
      const branchRead = this.deps.github
        .readPullRequestBehind(repo.github, after)
        .then((behindBy) => {
          value.behindBy = behindBy;
          publish();
        })
        .catch(this.deps.onError);
      const {
        requestedReviewers: _requestedReviewers,
        files: _fileDetails,
        reviews: _reviews,
        comments: _comments,
        branchExists: _branchExists,
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
      const rows = this.lists.get(repo.id) ?? new Map<number, PullRequestRow>();
      this.lists.set(repo.id, rows);
      rows.set(
        scope.number,
        pullRequestRow.parse({
          ...summary,
          repoId: repo.id,
          taskId: value.taskId,
        }),
      );
      this.publishList(repo.id);
      try {
        // A stale cached list may have started an old immutable comparison. It can
        // never be displayed against the new detail; fetch the freshly observed range.
        let result = pendingPatch ? await pendingPatch : null;
        if (
          !known ||
          known.headSha !== after.headSha ||
          known.baseSha !== after.baseSha
        )
          result = { patch: await readPatch(after), error: null };
        if (result?.error) throw result.error;
        if (!result?.patch || !matches(result.patch))
          throw new Error(
            "PR diff does not match the observed head and base; refresh to retry",
          );
        value.patch = result.patch;
        value.patchLoading = false;
        publish();
      } catch (error) {
        value.patchLoading = false;
        value.patchError = "Could not load the diff. Refresh to retry.";
        publish();
        throw error;
      } finally {
        await branchRead;
      }
    }
    this.publishList(repo.id);
    this.loaded.add(scopeKey(scope));
  }

  private async timed<T>(
    kind: string,
    repo: Repo,
    number: number | string,
    read: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    let outcome = "ok";
    try {
      return await read();
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      this.deps.log?.(
        `GitHub PR ${repo.id}#${number} ${kind}: ${Math.round(performance.now() - start)}ms (${outcome})`,
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.active.clear();
    await Promise.allSettled([
      ...this.commands.values(),
      ...this.reads.values(),
    ]);
  }
}
