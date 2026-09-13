import type {
  GitHubAdapter,
  IsoTime,
  PullRequestDetail,
  PullRequestSummary,
} from "@loom/core";
import { z } from "zod";
import { Api, type Pages } from "./api.js";
import { branchExists } from "./branches.js";
import { readCi } from "./checks.js";
import {
  type GhRunner,
  GitHubError,
  json,
  parse,
  response,
  utf8Prefix,
} from "./gh.js";
import * as s from "./schemas.js";

const LIST_QUERY = `query($owner: String!, $name: String!, $state: PullRequestState!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, states: [$state], after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title author { login } headRefName baseRefName headRefOid
        isDraft mergeable reviewDecision updatedAt createdAt url
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const PATCH_LIMIT = 8 * 1024 * 1024;

export function pullRequestReads(
  run: GhRunner,
  now: () => IsoTime,
): Pick<
  GitHubAdapter,
  "listPullRequests" | "readPullRequest" | "readPullRequestPatch"
> {
  const cache = new Map<string, Pages>();
  const lists = new Map<string, PullRequestSummary[]>();
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
    const commits = await api.all(
      `${endpoint}/commits?per_page=100`,
      z.array(s.commit),
    );
    const final = (await api.get(endpoint, s.pullDetail)).value;
    if (
      final.head.sha !== initial.head.sha ||
      final.base.ref !== initial.base.ref ||
      final.updated_at !== initial.updated_at ||
      final.commits !== initial.commits
    )
      throw new GitHubError("retryable", "GitHub PR changed during read");
    // GitHub limits the PR commits endpoint to 250; never silently expose an incomplete list.
    if (commits.length !== final.commits)
      throw new GitHubError("retryable", "GitHub PR commits are incomplete");
    return {
      branchExists:
        final.head.repo === undefined
          ? null
          : final.head.repo === null
            ? false
            : await branchExists(
                run,
                final.head.repo.full_name,
                final.head.ref,
              ),
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
      const [owner, name] = repo.split("/");
      const values: PullRequestSummary[] = [];
      const visited = new Set<string | null>();
      let cursor: string | null = null;
      do {
        // Match the REST reader's existing 1,000-page bound; never cache a partial list.
        if (visited.has(cursor) || visited.size >= 1000)
          throw new GitHubError(
            "retryable",
            "GitHub pagination did not complete",
          );
        visited.add(cursor);
        const result = response(
          await run(
            [
              "api",
              "graphql",
              "--hostname",
              "github.com",
              "--include",
              "--input",
              "-",
            ],
            JSON.stringify({
              query: LIST_QUERY,
              variables: {
                owner,
                name,
                state: state.toUpperCase(),
                cursor,
              },
            }),
          ),
        );
        const payload = json(result.body);
        const envelope = parse(s.graphqlEnvelope, payload);
        if (envelope.errors?.length)
          throw new GitHubError("retryable", "GitHub GraphQL read failed");
        const page = parse(s.pullRequestList, payload).data.repository
          .pullRequests;
        for (const pull of page.nodes) {
          const checks = pull.commits.nodes[0]?.commit.statusCheckRollup?.state;
          values.push({
            number: pull.number,
            title: pull.title,
            author: pull.author?.login ?? null,
            state,
            head: pull.headRefName,
            base: pull.baseRefName,
            headSha: pull.headRefOid,
            draft: pull.isDraft,
            mergeable:
              pull.mergeable === "MERGEABLE"
                ? "mergeable"
                : pull.mergeable === "CONFLICTING"
                  ? "conflicting"
                  : "unknown",
            checks:
              checks === undefined
                ? "none"
                : checks === "SUCCESS"
                  ? "success"
                  : checks === "FAILURE" || checks === "ERROR"
                    ? "failure"
                    : "pending",
            review:
              pull.reviewDecision === "APPROVED"
                ? "approved"
                : pull.reviewDecision === "CHANGES_REQUESTED"
                  ? "changes_requested"
                  : "none",
            createdAt: pull.createdAt,
            updatedAt: pull.updatedAt,
            url: pull.url,
            observedAt: now(),
          });
        }
        if (!page.pageInfo.hasNextPage) break;
        if (!page.pageInfo.endCursor)
          throw new GitHubError(
            "retryable",
            "GitHub pagination did not complete",
          );
        cursor = page.pageInfo.endCursor;
      } while (cursor !== null);
      values.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number,
      );
      // GraphQL has no ETag. Keep each unchanged row (including its observation time),
      // so a successful poll with identical owner facts produces no view patch.
      const previous = new Map(lists.get(key)?.map((row) => [row.number, row]));
      const mapped = values.map((row) => {
        const old = previous.get(row.number);
        const candidate = {
          ...row,
          observedAt: old?.observedAt ?? row.observedAt,
        };
        return old && JSON.stringify(old) === JSON.stringify(candidate)
          ? old
          : row;
      });
      remember(lists, key, mapped);
      return structuredClone(mapped);
    },
    async readPullRequest(repo, number) {
      s.repo.parse(repo);
      s.id.parse(number);
      const key = `detail:${repo}:${number}`;
      const api = new Api(run, cache.get(key));
      const value = await read(api, repo, number);
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
