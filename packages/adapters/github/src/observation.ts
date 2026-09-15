import type {
  GitHubComment,
  GitHubReview,
  IsoTime,
  PullRequestObservation,
} from "@loom/core";
import { z } from "zod";
import type { Api } from "./api.js";
import { readCi } from "./checks.js";
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
  // Independent resources: each `gh` call is a process and a round trip, so read them together.
  const [ci, reviewPages, issueComments, reviewComments] = await Promise.all([
    readCi(api, repo, initial.head.sha, now),
    api.all(`${pr}/reviews?per_page=100`, z.array(s.review)),
    api.all(
      `${root}/issues/${initial.number}/comments?per_page=100`,
      z.array(s.issueComment),
    ),
    api.all(`${pr}/comments?per_page=100`, z.array(s.reviewComment)),
  ]);
  const human = (user: { login: string; type: string } | null) =>
    user !== null &&
    user.type === "User" &&
    !excluded.has(user.login.toLowerCase());
  const comments: GitHubComment[] = [];
  const reviews: GitHubReview[] = [];
  for (const review of reviewPages) {
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
  for (const comment of issueComments) {
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
  for (const comment of reviewComments) {
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
    ci: {
      ...ci,
      checks: ci.checks.map(
        ({ startedAt: _start, completedAt: _end, ...check }) => check,
      ),
    },
    reviews,
    comments,
  };
}
