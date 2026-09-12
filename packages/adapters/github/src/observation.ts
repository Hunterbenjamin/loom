import type {
  CiState,
  GitHubComment,
  GitHubReview,
  IsoTime,
  PullRequestObservation,
} from "@loom/core";
import { z } from "zod";
import type { Api } from "./api.js";
import { GitHubError } from "./gh.js";
import * as s from "./schemas.js";

export async function observe(
  api: Api,
  repo: string,
  initial: s.Pull,
  excluded: ReadonlySet<string>,
  now: IsoTime,
): Promise<PullRequestObservation> {
  const root = `repos/${repo}`;
  const pr = `${root}/pulls/${initial.number}`;
  const rawChecks = await api.all(
    `${root}/commits/${initial.head.sha}/check-runs?per_page=100&filter=latest`,
    s.checks.transform((v) => v.check_runs),
  );
  const combined = (
    await api.get(`${root}/commits/${initial.head.sha}/status`, s.statuses)
  ).value;
  if (
    combined.sha !== initial.head.sha ||
    rawChecks.some((check) => check.head_sha !== initial.head.sha)
  )
    throw new GitHubError("retryable", "GitHub CI head changed during read");
  const human = (user: { login: string; type: string } | null) =>
    user !== null &&
    user.type === "User" &&
    !excluded.has(user.login.toLowerCase());
  const comments: GitHubComment[] = [];
  const reviews: GitHubReview[] = [];
  for (const review of await api.all(
    `${pr}/reviews?per_page=100`,
    z.array(s.review),
  )) {
    if (review.state === "PENDING") continue;
    if (!review.submitted_at)
      throw new GitHubError("fatal", "GitHub review has no submission time");
    if (human(review.user) && review.body.trim()) {
      comments.push({
        id: review.node_id,
        reviewId: String(review.id),
        path: null,
        line: null,
        side: null,
        commitSha: review.commit_id,
        body: review.body,
        author: review.user?.login ?? "ghost",
        createdAt: review.submitted_at,
      });
    }
    reviews.push({
      id: String(review.id),
      author: review.user?.login ?? "ghost",
      state: review.state.toLowerCase() as GitHubReview["state"],
      submittedAt: review.submitted_at,
    });
  }
  for (const comment of await api.all(
    `${root}/issues/${initial.number}/comments?per_page=100`,
    z.array(s.issueComment),
  )) {
    if (!human(comment.user)) continue;
    comments.push({
      id: String(comment.id),
      reviewId: null,
      path: null,
      line: null,
      side: null,
      commitSha: null,
      body: comment.body,
      author: comment.user?.login ?? "ghost",
      createdAt: comment.created_at,
    });
  }
  for (const comment of await api.all(
    `${pr}/comments?per_page=100`,
    z.array(s.reviewComment),
  )) {
    if (!human(comment.user)) continue;
    comments.push({
      id: String(comment.id),
      reviewId:
        comment.pull_request_review_id === null
          ? null
          : String(comment.pull_request_review_id),
      path: comment.path,
      line: comment.line,
      side:
        comment.side === null ? null : comment.side === "LEFT" ? "old" : "new",
      commitSha: comment.commit_id,
      body: comment.body,
      author: comment.user?.login ?? "ghost",
      createdAt: comment.created_at,
    });
  }
  // A push during pagination must not join old CI to a new head.
  const final = (await api.get(pr, s.pull)).value;
  if (
    final.head.sha !== initial.head.sha ||
    final.base.ref !== initial.base.ref
  )
    throw new GitHubError("retryable", "GitHub PR changed during read");
  const checks: CiState["checks"] = rawChecks.map((check) => ({
    id: String(check.id),
    name: check.name,
    status:
      check.status === "completed" || check.status === "in_progress"
        ? check.status
        : "queued",
    conclusion: check.conclusion,
    url: check.html_url,
  }));
  const failed = checks.some(
    (check) =>
      check.status === "completed" &&
      check.conclusion !== null &&
      !["success", "neutral", "skipped"].includes(check.conclusion),
  );
  const pending = checks.some(
    (check) => check.status !== "completed" || check.conclusion === null,
  );
  const conclusion =
    failed || (combined.total_count > 0 && combined.state === "failure")
      ? "failure"
      : pending || (combined.total_count > 0 && combined.state === "pending")
        ? "pending"
        : checks.length > 0 || combined.total_count > 0
          ? "success"
          : "none";
  return {
    number: final.number,
    url: final.html_url,
    state: final.merged ? "merged" : final.state,
    headSha: final.head.sha,
    baseBranch: final.base.ref,
    mergeable:
      final.mergeable === null
        ? "unknown"
        : final.mergeable
          ? "mergeable"
          : "conflicting",
    autoMergeEnabled: final.auto_merge !== null,
    mergeCommitSha: final.merged ? final.merge_commit_sha : null,
    mergedAt: final.merged_at,
    ci: { headSha: final.head.sha, conclusion, checks, observedAt: now },
    reviews,
    comments,
  };
}
