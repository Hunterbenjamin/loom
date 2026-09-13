import { z } from "zod";
import { ciCheck, ciState } from "./entities.js";
import { count, isoTime, repoId, sha, taskId } from "./ids.js";

export const pullRequestState = z.enum(["open", "closed", "merged"]);
export const pullRequestListKey = (repo: string, state: string): string =>
  JSON.stringify([repo, state]);
export const pullRequestListState = z.strictObject({
  repoId,
  state: pullRequestState,
  loading: z.boolean(),
});
export const pullRequestNumber = z.number().int().positive();
export const pullRequestKey = (repo: string, number: number): string =>
  JSON.stringify([repo, number]);

export const pullRequestSummary = z.strictObject({
  number: pullRequestNumber,
  title: z.string(),
  author: z.string().nullable(),
  state: pullRequestState,
  head: z.string().min(1),
  base: z.string().min(1),
  headSha: sha,
  createdAt: isoTime,
  updatedAt: isoTime,
  draft: z.boolean(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  checks: ciState.shape.conclusion,
  review: z.enum(["approved", "changes_requested", "none"]),
  url: z.url(),
  observedAt: isoTime,
});
export const pullRequestDetail = pullRequestSummary.extend({
  branchExists: z.boolean().nullable().default(null),
  body: z.string(),
  mergedAt: isoTime.nullable(),
  mergeCommitSha: sha.nullable(),
  commits: z.array(
    z.strictObject({
      sha,
      message: z.string(),
      author: z.string().nullable(),
      committedAt: isoTime.nullable(),
      url: z.url(),
    }),
  ),
  checkRuns: z.array(
    ciCheck.extend({
      startedAt: isoTime.nullable(),
      completedAt: isoTime.nullable(),
    }),
  ),
  additions: count,
  deletions: count,
  changedFiles: count,
});
export const pullRequestPatch = z.strictObject({
  patch: z
    .string()
    .refine(
      (v) => new TextEncoder().encode(v).length <= 8 * 1024 * 1024,
      "PR patches are capped at 8 MiB of UTF-8",
    ),
  truncated: z.boolean(),
  observedAt: isoTime,
});

const linkage = { repoId, taskId: taskId.nullable() };
export const pullRequestRow = pullRequestSummary.extend(linkage);
export const pullRequestDetailRow = z
  .strictObject({
    ...linkage,
    number: pullRequestNumber,
    detail: pullRequestDetail,
    patch: pullRequestPatch,
  })
  .refine((v) => v.number === v.detail.number, "PR number must match detail");
export type PullRequestRow = z.output<typeof pullRequestRow>;
export type PullRequestDetailRow = z.output<typeof pullRequestDetailRow>;

/** All repository commands name a registered repo, never an arbitrary GitHub URL. */
export const pullRequestCommand = z.union([
  z.strictObject({
    kind: z.literal("merge_pull_request"),
    repoId,
    number: pullRequestNumber,
    matchHeadSha: sha,
    deleteBranch: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("close_pull_request"),
    repoId,
    number: pullRequestNumber,
  }),
  // Resolve the branch from a fresh PR read, so deletion cannot target an unrelated branch.
  z.strictObject({
    kind: z.literal("delete_branch"),
    repoId,
    number: pullRequestNumber,
  }),
  z.strictObject({
    kind: z.literal("refresh_pull_requests"),
    repoId,
    state: pullRequestState.default("open"),
  }),
]);
export type PullRequestCommand = z.output<typeof pullRequestCommand>;
