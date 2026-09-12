import { createHash } from "node:crypto";
import type { GitHubAdapter, PullRequestObservation } from "@loom/core";
import { z } from "zod";
import { Api, type Pages } from "./api.js";
import { failure, type GhRunner, GitHubError, runGh } from "./gh.js";
import { observe } from "./observation.js";
import * as s from "./schemas.js";

export { type GhResult, type GhRunner, GitHubError } from "./gh.js";
export interface GitHubOptions {
  /** Login names used by Loom and its agents, including any shared human account. Required explicitly. */
  excludedAuthors: readonly string[];
  run?: GhRunner;
  now?: () => Date;
}

export function createGitHubAdapter(options: GitHubOptions): GitHubAdapter {
  const run = options.run ?? runGh;
  const excluded = new Set(
    z
      .array(z.string().min(1))
      .parse(options.excludedAuthors)
      .map((v) => v.toLowerCase()),
  );
  const snapshots = new Map<string, { etag: string; pages: Pages }>();

  const locate = async (api: Api, repo: string, branch: string) => {
    const label = branch.includes(":")
      ? branch
      : `${repo.split("/")[0]}:${branch}`;
    const pulls = await api.all(
      `repos/${repo}/pulls?state=all&head=${encodeURIComponent(label)}&sort=created&direction=desc&per_page=100`,
      z.array(s.pullSummary),
    );
    const matching = pulls.filter(
      (pr) =>
        pr.head.label.toLowerCase().split(":")[0] ===
          label.toLowerCase().split(":")[0] &&
        pr.head.ref === label.slice(label.indexOf(":") + 1),
    );
    // Prefer an open PR when a branch name was reused; otherwise the newest closed/merged PR.
    return matching.find((pr) => pr.state === "open") ?? matching[0] ?? null;
  };
  const freshPull = async (repo: string, number: number) =>
    (await new Api(run).get(`repos/${repo}/pulls/${number}`, s.pull)).value;
  const command = async (args: string[], input?: string) => {
    const result = await run(args, input);
    if (result.exitCode !== 0) throw failure(result);
  };

  return {
    async findPullRequest(req) {
      s.repo.parse(req.repo);
      s.branch.parse(req.branch);
      const key = `${req.repo}:${req.branch}`;
      const previous = snapshots.get(key);
      const api = new Api(
        run,
        req.etag === previous?.etag ? previous?.pages : undefined,
      );
      const summary = await locate(api, req.repo, req.branch);
      let value: PullRequestObservation | null = null;
      if (summary) {
        const initial = (
          await api.get(`repos/${req.repo}/pulls/${summary.number}`, s.pull)
        ).value;
        value = await observe(
          api,
          req.repo,
          initial,
          excluded,
          s.time.parse((options.now?.() ?? new Date()).toISOString()),
        );
      }
      // A single HTTP validator cannot cover these independent resources. The public token
      // identifies their normalized snapshot; native ETags remain scoped to each cached page.
      const stable =
        value === null
          ? null
          : { ...value, ci: { ...value.ci, observedAt: null } };
      const etag = `"loom-github-${createHash("sha256")
        .update(JSON.stringify([key, stable]))
        .digest("hex")}"`;
      snapshots.delete(key);
      snapshots.set(key, { etag, pages: api.pages });
      // Bounded, disposable cache; restart/eviction causes a full read, never unknown-as-empty.
      if (snapshots.size > 128) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) snapshots.delete(oldest);
      }
      return req.etag === etag
        ? { notModified: true }
        : { notModified: false, value, etag };
    },

    async openPullRequest(req) {
      s.repo.parse(req.repo);
      s.branch.parse(req.branch);
      s.branch.parse(req.baseBranch);
      const existing = await locate(new Api(run), req.repo, req.branch);
      if (existing) return { number: existing.number, url: existing.html_url };
      // stdin preserves multiline bodies without shell interpolation or temporary files.
      let creationError: unknown;
      try {
        await command(
          [
            "pr",
            "create",
            "--repo",
            `github.com/${req.repo}`,
            "--head",
            req.branch,
            "--base",
            req.baseBranch,
            "--title",
            req.title,
            "--body-file",
            "-",
          ],
          req.body,
        );
      } catch (error) {
        creationError = error;
      }
      // Also recovers a concurrent create or a successful write whose response was lost.
      const created = await locate(new Api(run), req.repo, req.branch);
      if (created) return { number: created.number, url: created.html_url };
      if (creationError) throw creationError;
      throw new GitHubError(
        "retryable",
        "Created GitHub PR is not yet observable",
      );
    },

    async mergePullRequest(req) {
      s.repo.parse(req.repo);
      s.id.parse(req.number);
      s.sha.parse(req.matchHeadSha);
      const before = await freshPull(req.repo, req.number);
      if (before.head.sha !== req.matchHeadSha)
        throw new GitHubError(
          "precondition",
          "GitHub PR head no longer matches approval",
        );
      if (before.merged) return { state: "merged" };
      if (before.state === "closed" || before.mergeable === false)
        throw new GitHubError("precondition", "GitHub PR cannot be merged");
      if (req.auto && before.auto_merge?.merge_method === "squash")
        return { state: "auto_merge_enabled" };
      const args = [
        "pr",
        "merge",
        String(req.number),
        "--repo",
        `github.com/${req.repo}`,
        "--squash",
        "--match-head-commit",
        req.matchHeadSha,
      ];
      if (req.auto) args.push("--auto");
      await command(args);
      const after = await freshPull(req.repo, req.number);
      if (after.head.sha !== req.matchHeadSha)
        throw new GitHubError(
          "precondition",
          "GitHub PR head changed during merge",
        );
      if (after.merged) return { state: "merged" };
      if (req.auto && after.auto_merge?.merge_method === "squash")
        return { state: "auto_merge_enabled" };
      throw new GitHubError(
        "retryable",
        "GitHub merge outcome is not yet observable",
      );
    },

    async disableAutoMerge(req) {
      s.repo.parse(req.repo);
      s.id.parse(req.number);
      if ((await freshPull(req.repo, req.number)).auto_merge === null) return;
      let disableError: unknown;
      try {
        await command([
          "pr",
          "merge",
          String(req.number),
          "--repo",
          `github.com/${req.repo}`,
          "--disable-auto",
        ]);
      } catch (error) {
        disableError = error;
      }
      if ((await freshPull(req.repo, req.number)).auto_merge === null) return;
      if (disableError) throw disableError;
      throw new GitHubError("retryable", "GitHub auto-merge is still enabled");
    },
  };
}
