import type { Action, Finding, Sha, TaskState } from "@loom/core";
import { type PullRequestCommand, pullRequestDetail } from "@loom/protocol";
import { indexChanges, mapFindings } from "../mapping.js";
import { pullRequestOwner } from "../pull-request-owner.js";
import type { Exclusive, ExecutorDeps } from "./deps.js";
import { Fatal, PreconditionFailed } from "./errors.js";

export class GitHubActions {
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly exclusive: Exclusive,
  ) {}

  /** Repository actions have no task/outbox identity; execute once and re-read before retry. */
  async pullRequest(command: PullRequestCommand): Promise<void> {
    const repo = this.deps.repoById(command.repoId);
    if (command.kind === "refresh_pull_requests") return;
    if (command.kind === "pin_pull_request") {
      this.deps.store.setPullRequestPreferences(repo.id, command.number, {
        pinned: command.pinned,
      });
      return;
    }
    if (command.kind === "link_pull_request") {
      const task = this.deps.store
        .tasks()
        .find(
          (task) =>
            task.repoId === repo.id &&
            task.id.toLowerCase() === command.taskKey.toLowerCase(),
        );
      if (!task)
        throw new PreconditionFailed(
          "No issue with that key in this repository",
        );
      this.deps.store.setPullRequestPreferences(repo.id, command.number, {
        taskId: task.id,
      });
      return;
    }
    const github = this.deps.adapters.github;
    const pr = pullRequestDetail.parse(
      await github.readPullRequest(repo.github, command.number),
    );
    switch (command.kind) {
      case "comment_pull_request":
        await github.commentPullRequest(
          repo.github,
          command.number,
          command.body,
          command.requestId,
        );
        return;
      case "merge_pull_request":
        if (
          pullRequestOwner(
            this.deps.store.tasks(),
            repo.id,
            pr.head,
            this.deps.store.pullRequestPreferences(repo.id, command.number)
              .taskId,
          )
        )
          throw new PreconditionFailed(
            "This PR belongs to an issue; approve its reviewed head through the issue",
          );
        if (pr.headSha !== command.matchHeadSha)
          throw new PreconditionFailed(
            "PR head changed; refresh and confirm the new head SHA",
          );
        if (
          pr.state !== "merged" &&
          (pr.state !== "open" ||
            pr.draft ||
            pr.mergeable !== "mergeable" ||
            !["success", "none"].includes(pr.checks))
        )
          throw new PreconditionFailed(
            "PR must be open, ready, mergeable and have no pending or failed checks",
          );
        await github.mergePullRequest({
          repo: repo.github,
          number: command.number,
          matchHeadSha: command.matchHeadSha,
          deleteBranch: command.deleteBranch,
          auto: false,
        });
        return;
      case "close_pull_request":
        await github.closePullRequest(repo.github, command.number);
        return;
      case "delete_branch":
        if (
          pr.state === "open" ||
          pr.head === pr.base ||
          pr.head === this.deps.repositorySettings(repo.id).baseBranch
        )
          throw new PreconditionFailed(
            "Only a merged or closed PR's non-base branch can be deleted",
          );
        await github.deleteBranch(repo.github, pr.head);
        return;
    }
  }

  async perform(
    action: Extract<
      Action,
      {
        kind:
          | "push_branch"
          | "open_pr"
          | "merge_pr"
          | "disable_auto_merge"
          | "map_findings"
          | "refresh";
      }
    >,
    state: TaskState,
  ): Promise<unknown> {
    const { adapters } = this.deps;
    if (
      (action.kind === "push_branch" && action.key.startsWith("rescue:")) ||
      (action.kind === "open_pr" && action.rescueHeadSha)
    ) {
      const expected =
        action.kind === "push_branch"
          ? action.expectedHeadSha
          : action.rescueHeadSha;
      const worktree = state.worktree;
      if (
        state.task.stage !== "in_progress" ||
        !worktree ||
        state.review ||
        state.runs.some(
          (r) =>
            !r.endedAt ||
            (r.role === "implementer" && r.endReason === "submitted"),
        ) ||
        !state.runs.some((r) => r.endReason === "vanished")
      )
        throw new PreconditionFailed("Rescue owner state changed");
      const git = await adapters.git.readWorktree(
        worktree.path,
        worktree.baseBranch,
      );
      if (
        !git.exists ||
        git.path !== worktree.path ||
        git.branch !== state.task.branch ||
        git.branch !== action.branch ||
        git.headSha !== expected ||
        git.dirty ||
        git.aheadOfBase < 1 ||
        (action.kind === "open_pr" && git.remoteHeadSha !== expected)
      )
        throw new PreconditionFailed(
          "Rescue branch or HEAD changed; human inspection required",
        );
    }
    switch (action.kind) {
      case "push_branch": {
        const baseBranch =
          state.worktree?.baseBranch ??
          this.deps.repositorySettings(state.task.repoId).baseBranch;
        if (action.branch === baseBranch)
          throw new Fatal("Refusing to push the repository base branch");
        // The remote may already be at this SHA, from an earlier attempt of the same intent.
        const observation = await adapters.git.readWorktree(
          action.worktreePath,
          baseBranch,
        );
        if (observation.remoteHeadSha === action.expectedHeadSha)
          return { remoteHeadSha: action.expectedHeadSha };
        return this.exclusive(this.deps.repo(action.taskId).root, () =>
          adapters.git.push({
            worktreePath: action.worktreePath,
            branch: action.branch,
            expectedHeadSha: action.expectedHeadSha,
            expectedRemoteHeadSha: observation.remoteHeadSha,
            nonForce: action.nonForce,
          }),
        );
      }
      case "open_pr": {
        const repo = this.deps.repo(action.taskId);
        const existing = await this.deps.pullRequests.read(
          adapters,
          repo.github,
          action.branch,
        );
        if (existing) return { number: existing.number, url: existing.url };
        const opened = await adapters.github.openPullRequest({
          repo: repo.github,
          branch: action.branch,
          baseBranch: action.baseBranch,
          title: action.title,
          body: action.body,
        });
        this.deps.pullRequests.forget(repo.github, action.branch);
        return opened;
      }
      case "merge_pr": {
        const repo = this.deps.repo(action.taskId);
        const result = await adapters.github.mergePullRequest({
          repo: repo.github,
          number: action.prNumber,
          matchHeadSha: action.matchHeadSha,
          auto: action.auto,
        });
        if (state.task.branch)
          this.deps.pullRequests.forget(repo.github, state.task.branch);
        return result;
      }
      case "disable_auto_merge": {
        const repo = this.deps.repo(action.taskId);
        await adapters.github.disableAutoMerge({
          repo: repo.github,
          number: action.prNumber,
        });
        if (state.task.branch)
          this.deps.pullRequests.forget(repo.github, state.task.branch);
        return {};
      }
      case "map_findings":
        return this.map(action, state);
      case "refresh": {
        if (action.owner === "github" && state.task.branch)
          this.deps.pullRequests.forget(
            this.deps.repo(action.taskId).github,
            state.task.branch,
          );
        if (action.owner === "codex_rate_limits")
          await (await adapters.codex(action.taskId)).readRateLimits();
        return {};
      }
    }
  }

  /** Reads the hunks between each anchor's head and the new one, then maps the ranges. */
  private async map(
    action: Extract<Action, { kind: "map_findings" }>,
    state: TaskState,
  ): Promise<{ locations: ReturnType<typeof mapFindings> }> {
    const wanted = new Set<string>(action.findingIds);
    const byHead = new Map<Sha, Finding[]>();
    for (const finding of state.findings) {
      if (!wanted.has(finding.id) || !finding.anchor) continue;
      const from = finding.location?.headSha ?? finding.anchor.headSha;
      byHead.set(from, [...(byHead.get(from) ?? []), finding]);
    }
    const locations: ReturnType<typeof mapFindings> = [];
    for (const [fromSha, findings] of byHead) {
      if (fromSha === action.toHeadSha) continue;
      const changes = await this.deps.adapters.git.changedFiles({
        repoRoot: action.worktreePath,
        fromSha,
        toSha: action.toHeadSha,
      });
      locations.push(
        ...mapFindings({
          findings,
          findingIds: findings.map((f) => f.id),
          toHeadSha: action.toHeadSha,
          changes: indexChanges(changes),
          mappedAt: this.deps.now(),
        }),
      );
    }
    return { locations };
  }
}
