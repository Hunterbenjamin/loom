import type {
  GitHubAdapter,
  IsoTime,
  PullRequestDetail,
  PullRequestSummary,
} from "@loom/core";
import { z } from "zod";
import { Api, type Pages } from "./api.js";
import { readCi } from "./checks.js";
import { type GhRunner, GitHubError, response, utf8Prefix } from "./gh.js";
import * as s from "./schemas.js";

const PATCH_LIMIT = 8 * 1024 * 1024;

export function pullRequestReads(
  run: GhRunner,
  now: () => IsoTime,
): Pick<
  GitHubAdapter,
  "listPullRequests" | "readPullRequest" | "readPullRequestPatch"
> {
  const cache = new Map<string, Pages>();
  const patches = new Map<
    string,
    { etag: string | null; patch: string; truncated: boolean }
  >();
  const remember = <T>(
    map: Map<string, T>,
    key: string,
    value: T,
    limit = 128,
  ) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  };
  const read = async (
    api: Api,
    repo: string,
    number: number,
    detail: boolean,
  ): Promise<PullRequestDetail> => {
    const endpoint = `repos/${repo}/pulls/${number}`;
    const initial = (await api.get(endpoint, s.pullDetail)).value;
    const ci = await readCi(api, repo, initial.head.sha, now());
    const reviews = await api.all(
      `${endpoint}/reviews?per_page=100`,
      z.array(s.review),
    );
    // Comments and pending reviews do not supersede a reviewer's latest decision.
    const latest = new Map<string, z.infer<typeof s.review>>();
    for (const review of reviews) {
      if (
        !review.user ||
        review.state === "PENDING" ||
        review.state === "COMMENTED"
      )
        continue;
      if (!review.submitted_at)
        throw new GitHubError("fatal", "GitHub review has no submission time");
      const key = review.user.login.toLowerCase();
      const previous = latest.get(key);
      if (
        !previous ||
        review.submitted_at > (previous.submitted_at ?? "") ||
        (review.submitted_at === previous.submitted_at &&
          review.id > previous.id)
      )
        latest.set(key, review);
    }
    const decisions = [...latest.values()];
    const commits = detail
      ? await api.all(`${endpoint}/commits?per_page=100`, z.array(s.commit))
      : [];
    const final = (await api.get(endpoint, s.pullDetail)).value;
    if (
      final.head.sha !== initial.head.sha ||
      final.base.ref !== initial.base.ref ||
      final.updated_at !== initial.updated_at ||
      final.commits !== initial.commits
    )
      throw new GitHubError("retryable", "GitHub PR changed during read");
    // GitHub limits the PR commits endpoint to 250; never silently expose an incomplete list.
    if (detail && commits.length !== final.commits)
      throw new GitHubError("retryable", "GitHub PR commits are incomplete");
    return {
      number: final.number,
      title: final.title,
      author: final.user?.login ?? null,
      state: final.merged ? "merged" : final.state,
      head: final.head.ref,
      base: final.base.ref,
      headSha: final.head.sha,
      createdAt: final.created_at,
      updatedAt: final.updated_at,
      draft: final.draft,
      mergeable:
        final.mergeable === null
          ? "unknown"
          : final.mergeable
            ? "mergeable"
            : "conflicting",
      checks: ci.conclusion,
      review: decisions.some((r) => r.state === "CHANGES_REQUESTED")
        ? "changes_requested"
        : decisions.some((r) => r.state === "APPROVED")
          ? "approved"
          : "none",
      url: final.html_url,
      observedAt: now(),
      body: final.body ?? "",
      mergedAt: final.merged_at,
      mergeCommitSha: final.merged ? final.merge_commit_sha : null,
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.author?.login ?? null,
        committedAt: c.commit.committer?.date ?? null,
        url: c.html_url,
      })),
      checkRuns: ci.checks,
      additions: final.additions,
      deletions: final.deletions,
      changedFiles: final.changed_files,
    };
  };
  return {
    async listPullRequests(repo, state) {
      s.repo.parse(repo);
      s.pullState.parse(state);
      const key = `list:${repo}:${state}`;
      const api = new Api(run, cache.get(key));
      const pulls = await api.all(
        `repos/${repo}/pulls?state=${state === "merged" ? "closed" : state}&sort=created&direction=desc&per_page=100`,
        z.array(s.pullSummary),
      );
      const values: PullRequestSummary[] = [];
      for (const pull of pulls) {
        const {
          body: _body,
          mergedAt: _at,
          mergeCommitSha: _sha,
          commits: _commits,
          checkRuns: _runs,
          additions: _add,
          deletions: _del,
          changedFiles: _files,
          ...summary
        } = await read(api, repo, pull.number, false);
        if (summary.state === state) values.push(summary);
      }
      values.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number,
      );
      remember(cache, key, api.pages);
      return values;
    },
    async readPullRequest(repo, number) {
      s.repo.parse(repo);
      s.id.parse(number);
      const key = `detail:${repo}:${number}`;
      const api = new Api(run, cache.get(key));
      const value = await read(api, repo, number, true);
      remember(cache, key, api.pages);
      return value;
    },
    async readPullRequestPatch(repo, number) {
      s.repo.parse(repo);
      s.id.parse(number);
      const key = `${repo}:${number}`;
      const cached = patches.get(key);
      const args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        "--header",
        "Accept: application/vnd.github.diff",
        `repos/${repo}/pulls/${number}`,
      ];
      if (cached?.etag) args.push("--header", `If-None-Match: ${cached.etag}`);
      // Header allowance is bounded too; the returned body is capped separately.
      const raw = await run(args, undefined, {
        stdoutLimit: PATCH_LIMIT + 64 * 1024,
      });
      const result = response(raw);
      if (result.status === 304) {
        if (!cached)
          throw new GitHubError(
            "retryable",
            "GitHub returned 304 without a cached patch",
          );
        return {
          patch: cached.patch,
          truncated: cached.truncated,
          observedAt: now(),
        };
      }
      const bytes = Buffer.from(result.body);
      if (!result.body.startsWith("diff --git "))
        throw new GitHubError("fatal", "Invalid GitHub diff response");
      const value = {
        etag: result.headers.etag ?? null,
        patch: utf8Prefix(bytes, PATCH_LIMIT),
        truncated: raw.truncated === true || bytes.length > PATCH_LIMIT,
      };
      remember(patches, key, value, 4);
      return {
        patch: value.patch,
        truncated: value.truncated,
        observedAt: now(),
      };
    },
  };
}
