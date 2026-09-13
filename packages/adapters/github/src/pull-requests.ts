import type {
  GitHubAdapter,
  IsoTime,
  PullRequestDetail,
  PullRequestSummary,
} from "@loom/core";
import { readDetail } from "./detail.js";
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
        number title author { login } headRefName baseRefName headRefOid baseRefOid
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
  const cache = new Map<string, PullRequestDetail>();
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
            baseSha: pull.baseRefOid,
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
    async readPullRequest(repo, number, options) {
      s.repo.parse(repo);
      s.id.parse(number);
      const key = `detail:${repo}:${number}`;
      const value = await readDetail(
        run,
        now,
        repo,
        number,
        options?.cached ? cache.get(key) : undefined,
      );
      remember(cache, key, value);
      return structuredClone(value);
    },
    async readPullRequestPatch(repo, number, range) {
      s.sha.parse(range.baseSha);
      s.sha.parse(range.headSha);
      s.repo.parse(repo);
      s.id.parse(number);
      const key = `${repo}:${number}:${range.baseSha}:${range.headSha}`;
      const cached = patches.get(key);
      if (cached)
        return {
          headSha: range.headSha,
          baseSha: range.baseSha,
          patch: cached.patch,
          truncated: cached.truncated,
          observedAt: now(),
        };
      const args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        "--header",
        "Accept: application/vnd.github.diff",
        `repos/${repo}/compare/${range.baseSha}...${range.headSha}`,
      ];
      // Header allowance is bounded too; the returned body is capped separately.
      const raw = await run(args, undefined, {
        stdoutLimit: PATCH_LIMIT + 64 * 1024,
      });
      const result = response(raw);
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
        headSha: range.headSha,
        baseSha: range.baseSha,
        patch: value.patch,
        truncated: value.truncated,
        observedAt: now(),
      };
    },
  };
}
