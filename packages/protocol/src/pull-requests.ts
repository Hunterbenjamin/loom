import { z } from "zod";
import { ciCheck, ciState } from "./entities.js";
import { count, fileId, isoTime, repoId, sha, taskId } from "./ids.js";
import { viewedFile } from "./views.js";

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
  viewerDidAuthor: z.boolean().default(false),
  viewerReviewRequested: z.boolean().default(false),
  reviewRequired: z.boolean().default(false),
  completedAt: isoTime.nullable().default(null),
  number: pullRequestNumber,
  title: z.string(),
  author: z.string().nullable(),
  state: pullRequestState,
  head: z.string().min(1),
  base: z.string().min(1),
  headSha: sha,
  baseSha: sha,
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
  requestedReviewers: z.array(z.string()).default([]),
  files: z.array(
    z.strictObject({
      path: z.string(),
      additions: count,
      deletions: count,
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
  reviews: z.array(
    z.strictObject({
      id: z.string(),
      author: z.string().nullable(),
      body: z.string(),
      state: z.enum([
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED",
        "DISMISSED",
        "PENDING",
      ]),
      submittedAt: isoTime.nullable(),
      url: z.url(),
    }),
  ),
  comments: z.array(
    z.strictObject({
      id: z.string(),
      author: z.string().nullable(),
      body: z.string(),
      createdAt: isoTime,
      url: z.url(),
    }),
  ),
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
  headSha: sha,
  baseSha: sha,
  patch: z
    .string()
    .refine(
      (v) => new TextEncoder().encode(v).length <= 8 * 1024 * 1024,
      "PR patches are capped at 8 MiB of UTF-8",
    ),
  truncated: z.boolean(),
  observedAt: isoTime,
});

/** PR review state reuses the viewed-file contract, independently of an issue. */
export const pullRequestReviewChange = z.strictObject({
  kind: z.literal("save_review_state"),
  repoId,
  number: pullRequestNumber,
  change: z.strictObject({
    headSha: sha,
    viewed: z.array(viewedFile).optional(),
    unviewed: z.array(fileId).optional(),
  }),
});
export const pullRequestDiffRead = z.union([
  z.strictObject({
    kind: z.literal("fetch_pull_request_commit"),
    repoId,
    number: pullRequestNumber,
    headSha: sha,
    commitSha: sha,
  }),
  z.strictObject({
    kind: z.literal("fetch_pull_request_file"),
    repoId,
    number: pullRequestNumber,
    headSha: sha,
    commitSha: sha.nullable(),
    path: z.string().min(1),
    ignoreWhitespace: z.boolean(),
  }),
]);
export const pullRequestCommitDiff = z.strictObject({
  patch: pullRequestPatch,
  files: pullRequestDetail.shape.files,
});
export const pullRequestFileContents = z.strictObject({
  old: z.string(),
  new: z.string(),
  patch: z.string(),
});

const linkage = { repoId, taskId: taskId.nullable() };
export const pullRequestRow = pullRequestSummary.extend(linkage);
export const pullRequestDetailRow = z
  .strictObject({
    ...linkage,
    number: pullRequestNumber,
    pinned: z.boolean().default(false),
    viewedFiles: z.array(viewedFile).default([]),
    behindBy: count.nullable().default(null),
    detail: pullRequestDetail,
    patch: pullRequestPatch.nullable(),
    patchLoading: z.boolean().default(false),
    patchError: z.string().nullable().default(null),
  })
  .refine((v) => v.number === v.detail.number, "PR number must match detail")
  .refine(
    (v) =>
      !v.patch ||
      (v.patch.headSha === v.detail.headSha &&
        v.patch.baseSha === v.detail.baseSha),
    "PR patch must match detail SHAs",
  );
export type PullRequestRow = z.output<typeof pullRequestRow>;
export type PullRequestDetailRow = z.output<typeof pullRequestDetailRow>;

/** All repository commands name a registered repo, never an arbitrary GitHub URL. */
export const pullRequestCommand = z.union([
  z.strictObject({
    kind: z.literal("pin_pull_request"),
    repoId,
    number: pullRequestNumber,
    pinned: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("link_pull_request"),
    repoId,
    number: pullRequestNumber,
    taskKey: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("comment_pull_request"),
    repoId,
    number: pullRequestNumber,
    body: z.string().trim().min(1).max(60000),
    requestId: z.uuid(),
  }),
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
