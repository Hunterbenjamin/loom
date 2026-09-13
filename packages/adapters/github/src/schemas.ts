import type { IsoTime, Sha } from "@loom/core";
import { z } from "zod";

export const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
export const branch = z
  .string()
  .min(1)
  .refine(
    (v) =>
      !v.startsWith("-") &&
      !/[\s?*[\\~^{}]/.test(v) &&
      [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      v.split(":").length <= 2,
  );
export const sha = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .transform((v) => v as Sha);
export const time = z.iso.datetime().transform((v) => v as IsoTime);
export const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const author = z
  .object({ login: z.string().min(1), type: z.string() })
  .nullable();
const head = z.object({ ref: z.string(), sha, label: z.string() });
export const pullSummary = z.object({
  number: id,
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  head,
});
export const pull = pullSummary.extend({
  base: z.object({ ref: z.string().min(1) }),
  merged: z.boolean(),
  mergeable: z.boolean().nullable(),
  auto_merge: z
    .object({ merge_method: z.enum(["merge", "squash", "rebase"]) })
    .nullable(),
  merge_commit_sha: sha.nullable(),
  merged_at: time.nullable(),
});
export type Pull = z.infer<typeof pull>;
export const check = z.object({
  id,
  name: z.string().min(1),
  head_sha: sha,
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: z.string().nullable(),
  html_url: z.url().nullable(),
  started_at: time.nullable().optional(),
  completed_at: time.nullable().optional(),
});
export const checks = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(check),
});
export const statuses = z.object({
  sha,
  state: z.enum(["success", "pending", "failure"]),
  total_count: z.number().int().nonnegative(),
});
export const review = z.object({
  id,
  node_id: z.string().min(1),
  body: z.string(),
  commit_id: sha.nullable(),
  user: author,
  state: z.enum([
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
    "PENDING",
  ]),
  submitted_at: time.nullable().optional(),
});
export const issueComment = z.object({
  id,
  user: author,
  body: z.string(),
  created_at: time,
});
export const reviewComment = issueComment.extend({
  pull_request_review_id: id.nullable(),
  path: z.string(),
  line: id.nullable(),
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  commit_id: sha,
});

export const pullState = z.enum(["open", "closed", "merged"]);
export const pullDetail = pull.extend({
  head: head.extend({
    repo: z.object({ full_name: repo }).nullable().optional(),
  }),
  title: z.string(),
  user: author,
  body: z.string().nullable(),
  created_at: time,
  updated_at: time,
  draft: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  commits: z.number().int().nonnegative(),
});
export const commit = z.object({
  sha,
  html_url: z.url(),
  author,
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: time.nullable() }).nullable(),
  }),
});
export const headRepository = z.object({
  head: z.object({
    ref: branch,
    repo: z.object({ full_name: repo }).nullable(),
  }),
});
export const ref = z.object({ ref: z.string(), object: z.object({ sha }) });
export const apiError = z.object({ message: z.string() });

/** Literal remote branch, without the fork-owner syntax accepted by PR lookup. */
export const remoteBranch = branch.refine(
  (v) =>
    !v.includes(":") &&
    !v.includes("..") &&
    !v.includes("@{") &&
    !v.startsWith("/") &&
    !v.endsWith("/") &&
    !v.endsWith(".") &&
    v !== "@" &&
    v
      .split("/")
      .every(
        (part) =>
          part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
      ),
);

export const graphqlEnvelope = z.object({
  errors: z.array(z.unknown()).optional(),
});
export const graphqlPullRequest = z.object({
  viewerDidAuthor: z.boolean(),
  viewerLatestReviewRequest: z.object({ id: z.string() }).nullable(),
  closedAt: time.nullable(),
  number: id,
  title: z.string(),
  author: z.object({ login: z.string().min(1) }).nullable(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  headRefOid: sha,
  baseRefOid: sha,
  isDraft: z.boolean(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
    .nullable(),
  updatedAt: time,
  createdAt: time,
  url: z.url(),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            statusCheckRollup: z
              .object({
                state: z.enum([
                  "SUCCESS",
                  "PENDING",
                  "EXPECTED",
                  "FAILURE",
                  "ERROR",
                ]),
              })
              .nullable(),
          }),
        }),
      )
      .max(1),
  }),
});
export const pullRequestList = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        nodes: z.array(graphqlPullRequest).max(100),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
      }),
    }),
  }),
});
