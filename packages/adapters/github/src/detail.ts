// Repository review projections use GraphQL; task observations retain their REST contract.
import type { IsoTime, PullRequestDetail } from "@loom/core";
import { z } from "zod";
import { type GhRunner, GitHubError, json, parse, response } from "./gh.js";
import * as s from "./schemas.js";

const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable().optional(),
});
const connection = <T extends z.ZodType>(node: T) =>
  z.object({
    nodes: z.array(node),
    pageInfo,
  });
const actor = z.object({ login: z.string() }).nullable();
const check = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    databaseId: s.id,
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.url().nullable(),
    startedAt: s.time.nullable(),
    completedAt: s.time.nullable(),
  }),
  z.object({ __typename: z.literal("StatusContext") }),
]);
const latest = z.object({
  nodes: z
    .array(
      z.object({
        commit: z.object({
          oid: s.sha,
          statusCheckRollup: z
            .object({
              state: z.enum([
                "SUCCESS",
                "PENDING",
                "EXPECTED",
                "FAILURE",
                "ERROR",
              ]),
              contexts: connection(check),
            })
            .nullable(),
        }),
      }),
    )
    .max(1),
});
const content = {
  body: z.string(),
  commits: connection(
    z.object({
      commit: z.object({
        oid: s.sha,
        message: z.string(),
        author: z.object({ user: actor }).nullable(),
        committedDate: s.time,
        url: z.url(),
      }),
    }),
  ),
  files: connection(
    z.object({
      path: z.string(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      changeType: z.enum([
        "ADDED",
        "DELETED",
        "MODIFIED",
        "RENAMED",
        "COPIED",
        "CHANGED",
        "UNCHANGED",
      ]),
    }),
  ),
  reviews: connection(
    z.object({
      id: z.string(),
      author: actor,
      body: z.string(),
      state: z.enum([
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED",
        "DISMISSED",
        "PENDING",
      ]),
      submittedAt: s.time.nullable(),
      url: z.url(),
    }),
  ),
  reviewRequests: connection(
    z.object({
      requestedReviewer: z
        .object({ login: z.string().optional(), name: z.string().optional() })
        .nullable(),
    }),
  ),
  comments: connection(
    z.object({
      id: z.string(),
      author: actor,
      body: z.string(),
      createdAt: s.time,
      url: z.url(),
    }),
  ),
};
const metadata = s.graphqlPullRequest.omit({ commits: true }).extend({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  baseRefOid: s.sha,
  headRef: z.object({ name: z.string() }).nullable(),
  headRepository: z.object({ nameWithOwner: s.repo }).nullable(),
  mergedAt: s.time.nullable(),
  mergeCommit: z.object({ oid: s.sha }).nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  latest,
});
const full = metadata.extend(content);
const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $content: Boolean!) {
 repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  viewerDidAuthor viewerLatestReviewRequest { id } closedAt
  number title author { login } state headRefName baseRefName headRefOid baseRefOid
  headRef { name } headRepository { nameWithOwner }
  isDraft mergeable reviewDecision updatedAt createdAt url mergedAt mergeCommit { oid }
  additions deletions changedFiles
  latest: commits(last: 1) { nodes { commit { oid statusCheckRollup { state
   contexts(first: 100) { nodes { __typename ... on CheckRun {
    databaseId name status conclusion detailsUrl startedAt completedAt
   } } pageInfo { hasNextPage endCursor } }
  } } } }
  reviewRequests(first: 100) @include(if: $content) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on EnterpriseTeam { name } ... on Mannequin { login } ... on Bot { login } } } pageInfo { hasNextPage endCursor } }
  body @include(if: $content)
  commits(first: 100) @include(if: $content) { nodes { commit {
   oid message author { user { login } } committedDate url
  } } pageInfo { hasNextPage endCursor } }
  files(first: 100) @include(if: $content) { nodes { path additions deletions changeType } pageInfo { hasNextPage endCursor } }
  reviews(first: 100) @include(if: $content) { nodes { id author { login } body state submittedAt url } pageInfo { hasNextPage endCursor } }
  comments(first: 100) @include(if: $content) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } }
 } }
}`;

export async function readDetail(
  run: GhRunner,
  now: () => IsoTime,
  repo: string,
  number: number,
  cached?: PullRequestDetail,
): Promise<PullRequestDetail> {
  const [owner, name] = repo.split("/");
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
        query: DETAIL_QUERY,
        variables: { owner, name, number, content: !cached },
      }),
    ),
  );
  const payload = json(result.body);
  if (parse(s.graphqlEnvelope, payload).errors?.length)
    throw new GitHubError("retryable", "GitHub GraphQL detail read failed");
  const raw = parse(
    z.object({
      data: z.object({ repository: z.object({ pullRequest: z.unknown() }) }),
    }),
    payload,
  ).data.repository.pullRequest;
  const meta = parse(metadata, raw);
  // Checks can change without a push. An edited PR, retarget, or push invalidates its content.
  if (
    cached &&
    (meta.headRefOid !== cached.headSha ||
      meta.baseRefOid !== cached.baseSha ||
      meta.updatedAt !== cached.updatedAt)
  )
    return readDetail(run, now, repo, number);
  const data = cached ? null : parse(full, raw);
  const last = meta.latest.nodes[0]?.commit;
  if (last && last.oid !== meta.headRefOid)
    throw new GitHubError("retryable", "GitHub CI head changed during read");
  const rollup = last?.statusCheckRollup;
  await Promise.all([
    ...(rollup
      ? [
          complete(
            rollup.contexts,
            check,
            "contexts",
            `contexts(first: 100, after: $cursor) { nodes { __typename ... on CheckRun { databaseId name status conclusion detailsUrl startedAt completedAt } } pageInfo { hasNextPage endCursor } }`,
          ),
        ]
      : []),
    ...(data
      ? [
          complete(
            data.commits,
            content.commits.shape.nodes.element,
            "commits",
            `commits(first: 100, after: $cursor) { nodes { commit { oid message author { user { login } } committedDate url } } pageInfo { hasNextPage endCursor } }`,
          ),
          complete(
            data.files,
            content.files.shape.nodes.element,
            "files",
            `files(first: 100, after: $cursor) { nodes { path additions deletions changeType } pageInfo { hasNextPage endCursor } }`,
          ),
          complete(
            data.reviews,
            content.reviews.shape.nodes.element,
            "reviews",
            `reviews(first: 100, after: $cursor) { nodes { id author { login } body state submittedAt url } pageInfo { hasNextPage endCursor } }`,
          ),
          complete(
            data.reviewRequests,
            content.reviewRequests.shape.nodes.element,
            "reviewRequests",
            `reviewRequests(first: 100, after: $cursor) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on EnterpriseTeam { name } ... on Mannequin { login } ... on Bot { login } } } pageInfo { hasNextPage endCursor } }`,
          ),
          complete(
            data.comments,
            content.comments.shape.nodes.element,
            "comments",
            `comments(first: 100, after: $cursor) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } }`,
          ),
        ]
      : []),
  ]);
  async function complete<T extends z.ZodType>(
    page: z.output<ReturnType<typeof connection<T>>>,
    schema: T,
    field: string,
    selection: string,
  ) {
    const visited = new Set<string>();
    while (page.pageInfo.hasNextPage) {
      const cursor = page.pageInfo.endCursor;
      if (!cursor || visited.has(cursor) || visited.size >= 999)
        throw new GitHubError(
          "retryable",
          "GitHub PR detail pagination is incomplete",
        );
      visited.add(cursor);
      const select =
        field === "contexts"
          ? `latest: commits(last: 1) { nodes { commit { statusCheckRollup { ${selection} } } } }`
          : selection;
      const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid baseRefOid updatedAt ${select} } }
      }`;
      const responseBody = json(
        response(
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
              query,
              variables: { owner, name, number, cursor },
            }),
          ),
        ).body,
      );
      if (parse(s.graphqlEnvelope, responseBody).errors?.length)
        throw new GitHubError(
          "retryable",
          "GitHub GraphQL detail pagination failed",
        );
      const identity = z.object({
        headRefOid: s.sha,
        baseRefOid: s.sha,
        updatedAt: s.time,
      });
      const nextRaw = parse(
        z.object({
          data: z.object({
            repository: z.object({ pullRequest: z.unknown() }),
          }),
        }),
        responseBody,
      ).data.repository.pullRequest;
      const nextIdentity = parse(identity, nextRaw);
      if (
        nextIdentity.headRefOid !== meta.headRefOid ||
        nextIdentity.baseRefOid !== meta.baseRefOid ||
        nextIdentity.updatedAt !== meta.updatedAt
      )
        throw new GitHubError(
          "retryable",
          "GitHub PR changed during pagination",
        );
      // Validate the nested connection before appending; never cache partial pages.
      const parsed = parse(z.record(z.string(), z.unknown()), nextRaw);
      const nested =
        field === "contexts"
          ? parse(
              z.object({
                latest: z.object({
                  nodes: z
                    .array(
                      z.object({
                        commit: z.object({
                          statusCheckRollup: z.object({
                            contexts: connection(schema),
                          }),
                        }),
                      }),
                    )
                    .length(1),
                }),
              }),
              parsed,
            ).latest.nodes[0]?.commit.statusCheckRollup.contexts
          : parse(connection(schema), parsed[field]);
      if (!nested)
        throw new GitHubError(
          "retryable",
          "GitHub PR detail pagination is incomplete",
        );
      page.nodes.push(...nested.nodes);
      page.pageInfo = nested.pageInfo;
    }
  }
  const checks = rollup?.state;
  const previous = cached ?? mapContent(data ?? parse(full, raw));
  return {
    ...previous,
    number: meta.number,
    title: meta.title,
    author: meta.author?.login ?? null,
    viewerDidAuthor: meta.viewerDidAuthor,
    viewerReviewRequested: meta.viewerLatestReviewRequest !== null,
    reviewRequired: meta.reviewDecision === "REVIEW_REQUIRED",
    completedAt: meta.closedAt,
    state:
      meta.state === "OPEN"
        ? "open"
        : meta.state === "MERGED"
          ? "merged"
          : "closed",
    head: meta.headRefName,
    base: meta.baseRefName,
    headSha: meta.headRefOid,
    baseSha: meta.baseRefOid,
    branchExists: meta.headRef !== null,
    draft: meta.isDraft,
    mergeable:
      meta.mergeable === "MERGEABLE"
        ? "mergeable"
        : meta.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    review:
      meta.reviewDecision === "APPROVED"
        ? "approved"
        : meta.reviewDecision === "CHANGES_REQUESTED"
          ? "changes_requested"
          : "none",
    checks: !checks
      ? "none"
      : checks === "SUCCESS"
        ? "success"
        : checks === "FAILURE" || checks === "ERROR"
          ? "failure"
          : "pending",
    checkRuns: (rollup?.contexts.nodes ?? []).flatMap((c) =>
      c.__typename === "CheckRun"
        ? [
            {
              id: String(c.databaseId),
              name: c.name,
              status:
                c.status === "COMPLETED"
                  ? ("completed" as const)
                  : c.status === "IN_PROGRESS"
                    ? ("in_progress" as const)
                    : ("queued" as const),
              conclusion: c.conclusion?.toLowerCase() ?? null,
              url: c.detailsUrl,
              startedAt: c.startedAt,
              completedAt: c.completedAt,
            },
          ]
        : [],
    ),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    observedAt: now(),
    url: meta.url,
    mergedAt: meta.mergedAt,
    mergeCommitSha:
      meta.state === "MERGED" ? (meta.mergeCommit?.oid ?? null) : null,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
  };
}

function mapContent(data: z.infer<typeof full>) {
  return {
    requestedReviewers: data.reviewRequests.nodes.flatMap(
      (r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name ?? [],
    ),
    body: data.body,
    commits: data.commits.nodes.map(({ commit: c }) => ({
      sha: c.oid,
      message: c.message,
      author: c.author?.user?.login ?? null,
      committedAt: c.committedDate,
      url: c.url,
    })),
    files: data.files.nodes,
    reviews: data.reviews.nodes.map((r) => ({
      ...r,
      author: r.author?.login ?? null,
    })),
    comments: data.comments.nodes.map((c) => ({
      ...c,
      author: c.author?.login ?? null,
    })),
  };
}
