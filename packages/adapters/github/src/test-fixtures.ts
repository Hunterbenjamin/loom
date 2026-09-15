import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { type GhResult, type GhRunner, response } from "./gh.js";
import { createGitHubAdapter } from "./index.js";
import * as s from "./schemas.js";

export const fixture = (name: string): string => {
  if (name === "not-modified") {
    const recorded = JSON.parse(
      readFileSync(
        new URL("./fixtures/not-modified.json", import.meta.url),
        "utf8",
      ),
    ) as { stdout: string };
    return recorded.stdout;
  }
  return readFileSync(
    new URL(`./fixtures/${name}.http`, import.meta.url),
    "utf8",
  );
};
export const ok = (stdout = ""): GhResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});
export const body = (name: string): unknown =>
  JSON.parse(response(ok(fixture(name))).body);
export const original = s.pull.parse(body("pull"));
export const request = {
  repo: "vuejs/core",
  branch: original.head.ref,
  etag: null,
};
export const root = "repos/vuejs/core";
export const pr = `${root}/pulls/${original.number}`;
export const list = `${root}/pulls?state=all&head=${encodeURIComponent(original.head.label)}&sort=created&direction=desc&per_page=100`;
export const checksPath = `${root}/commits/${original.head.sha}/check-runs?per_page=100&filter=latest`;
export const statusesPath = `${root}/commits/${original.head.sha}/status`;
export const reviewsPath = `${pr}/reviews?per_page=100`;
export const issuePath = `${root}/issues/${original.number}/comments?per_page=100`;
export const commentsPath = `${pr}/comments?per_page=100`;
export const mergeRequest = {
  repo: request.repo,
  number: original.number,
  matchHeadSha: original.head.sha,
  auto: false,
};
export const openRequest = {
  repo: request.repo,
  branch: request.branch,
  baseBranch: "minor",
  title: "Title",
  body: "line one\nline two `literal` $(literal)",
};

export function http(value: unknown, headers: Record<string, string> = {}) {
  const content = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(content).digest("hex")}"`;
  return `HTTP/2.0 200 OK\nEtag: ${etag}\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\n`)
    .join("")}\n${content}`;
}

const graphqlFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/pull-requests-graphql.json", import.meta.url),
    "utf8",
  ),
);
export const graphqlNode = s.graphqlPullRequest.parse(
  graphqlFixture.data.repository.pullRequests.nodes[0],
);
export const graphqlPage = (
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  data: {
    repository: {
      pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } },
    },
  },
});

export function setup(excludedAuthors: string[] = []) {
  const routes = new Map<string, GhResult>([
    [
      `${root}/git/ref/heads/${encodeURIComponent(original.head.ref)}`,
      ok(
        http({
          ref: `refs/heads/${original.head.ref}`,
          object: { sha: original.head.sha },
        }),
      ),
    ],
    [list, ok(fixture("pulls"))],
    [pr, ok(fixture("pull"))],
    [checksPath, ok(fixture("checks"))],
    [statusesPath, ok(fixture("statuses"))],
    [reviewsPath, ok(fixture("reviews"))],
    [issuePath, ok(fixture("issue-comments"))],
    [commentsPath, ok(fixture("review-comments"))],
  ]);
  const set = (
    endpoint: string,
    value: unknown,
    headers?: Record<string, string>,
  ) => routes.set(endpoint, ok(http(value, headers)));
  let mutate: GhRunner = async () => {
    throw new Error("Unexpected mutation");
  };
  const run = vi.fn<GhRunner>(async (args, input) => {
    if (args[0] === "api" && args[1] === "graphql") {
      const { variables } = JSON.parse(input ?? "{}");
      if (variables.number) {
        const explicit = routes.get(`graphql:detail:${variables.number}`);
        if (explicit) return explicit;
        const pull = s.pullDetail.parse(
          JSON.parse(response(required(routes.get(pr))).body),
        );
        const commits = s.commit
          .array()
          .parse(
            JSON.parse(
              response(required(routes.get(`${pr}/commits?per_page=100`))).body,
            ),
          );
        const checks = s.checks.parse(
          JSON.parse(response(required(routes.get(checksPath))).body),
        );
        const statuses = s.statuses.parse(
          JSON.parse(response(required(routes.get(statusesPath))).body),
        );
        const reviews = s.review
          .array()
          .parse(JSON.parse(response(required(routes.get(reviewsPath))).body));
        const decisions = new Map<string, string>();
        for (const r of [...reviews].sort(
          (a, b) =>
            (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "") ||
            a.id - b.id,
        ))
          if (r.user && r.state !== "PENDING" && r.state !== "COMMENTED")
            decisions.set(r.user.login, r.state);
        const native = (nodes: unknown[], more = false) => ({
          nodes,
          pageInfo: { hasNextPage: more },
        });
        const ref =
          pull.head.repo &&
          routes.get(
            `repos/${pull.head.repo.full_name}/git/ref/heads/${encodeURIComponent(pull.head.ref)}`,
          );
        return ok(
          http({
            data: {
              repository: {
                pullRequest: {
                  ...graphqlNode,
                  number: pull.number,
                  title: pull.title,
                  body: pull.body ?? "",
                  author: pull.user,
                  headRefName: pull.head.ref,
                  headRefOid: pull.head.sha,
                  baseRefName: pull.base.ref,
                  state: pull.merged ? "MERGED" : pull.state.toUpperCase(),
                  isDraft: pull.draft,
                  headRef: ref?.exitCode === 0 ? { name: pull.head.ref } : null,
                  headRepository: pull.head.repo
                    ? { nameWithOwner: pull.head.repo.full_name }
                    : null,
                  mergeable:
                    pull.mergeable === null
                      ? "UNKNOWN"
                      : pull.mergeable
                        ? "MERGEABLE"
                        : "CONFLICTING",
                  reviewDecision: [...decisions.values()].includes(
                    "CHANGES_REQUESTED",
                  )
                    ? "CHANGES_REQUESTED"
                    : [...decisions.values()].includes("APPROVED")
                      ? "APPROVED"
                      : null,
                  createdAt: pull.created_at,
                  updatedAt: pull.updated_at,
                  mergedAt: pull.merged_at,
                  mergeCommit: pull.merge_commit_sha
                    ? { oid: pull.merge_commit_sha }
                    : null,
                  additions: pull.additions,
                  deletions: pull.deletions,
                  changedFiles: pull.changed_files,
                  latest: {
                    nodes: [
                      {
                        commit: {
                          oid: pull.head.sha,
                          statusCheckRollup: {
                            state:
                              statuses.total_count &&
                              statuses.state === "failure"
                                ? "FAILURE"
                                : "SUCCESS",
                            contexts: native(
                              checks.check_runs.map((c) => ({
                                __typename: "CheckRun",
                                databaseId: c.id,
                                name: c.name,
                                status: c.status.toUpperCase(),
                                conclusion: c.conclusion?.toUpperCase() ?? null,
                                detailsUrl: c.html_url,
                                startedAt: c.started_at ?? null,
                                completedAt: c.completed_at ?? null,
                              })),
                            ),
                          },
                        },
                      },
                    ],
                  },
                  commits: native(
                    commits.map((c) => ({
                      commit: {
                        oid: c.sha,
                        message: c.commit.message,
                        author: { user: c.author },
                        committedDate: c.commit.committer?.date,
                        url: c.html_url,
                      },
                    })),
                    pull.commits > commits.length,
                  ),
                  files: native([
                    {
                      path: "example.ts",
                      additions: pull.additions,
                      deletions: pull.deletions,
                      changeType: "MODIFIED",
                    },
                  ]),
                  reviews: native(
                    reviews.map((r) => ({
                      id: r.node_id,
                      author: r.user,
                      body: r.body,
                      state: r.state,
                      submittedAt: r.submitted_at ?? null,
                      url: pull.html_url,
                    })),
                  ),
                  reviewRequests: native([]),
                  comments: native([]),
                },
              },
            },
          }),
        );
      }
      const key = `graphql:${variables.state}:${variables.cursor ?? ""}`;
      const result = routes.get(key);
      if (!result) throw new Error(`Missing fixture: ${key}`);
      return result;
    }
    if (
      args[0] !== "api" ||
      (args.includes("--method") && !args.includes("GET"))
    )
      return mutate(args, input);
    const endpoint = args.find(
      (arg) => arg.startsWith("repos/") || arg.startsWith("repositories/"),
    );
    const result = routes.get(endpoint ?? "");
    if (!result) throw new Error(`Missing fixture: ${endpoint}`);
    if (result.exitCode !== 0) return result;
    const etag = response(result).headers.etag;
    if (etag && args.includes(`If-None-Match: ${etag}`)) {
      return {
        stdout: `HTTP/2.0 304 Not Modified\nEtag: ${etag}\n\n`,
        stderr: "gh: HTTP 304",
        exitCode: 1,
      };
    }
    return result;
  });
  const adapter = createGitHubAdapter({
    excludedAuthors,
    run,
    now: () => new Date("2026-09-12T00:00:00Z"),
  });
  return {
    adapter,
    run,
    routes,
    set,
    mutate: (handler: GhRunner) => {
      mutate = handler;
    },
    open: () =>
      set(pr, {
        ...original,
        merged: false,
        state: "open",
        merged_at: null,
        mergeable: true,
      }),
  };
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}
