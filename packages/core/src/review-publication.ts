import type { Context } from "./context.js";
import { openBlocking } from "./helpers.js";

/** Persist publication before approval. Retries target the same immutable SHA and outbox keys. */
export function publishReview(c: Context, summary?: string): void {
  const { state, task, pr, git } = c;
  const head = state.review?.lastReviewedHead;
  if (
    !state.review?.publicationPending ||
    !head ||
    !state.worktree ||
    !task.branch ||
    task.stage !== "in_review" ||
    task.blocked ||
    openBlocking(state.findings)
  )
    return;
  const pushKey = c.emit(`push_branch:${task.id}:${head}`, {
    kind: "push_branch",
    worktreePath: state.worktree.path,
    branch: task.branch,
    expectedHeadSha: head,
  });
  if (!task.prNumber && c.observations.github?.ok && !pr) {
    const openKey = c.emit(`open_pr:${task.id}:${task.branch}`, {
      kind: "open_pr",
      repoId: task.repoId,
      branch: task.branch,
      baseBranch: state.worktree.baseBranch,
      title: task.title,
      body:
        summary ??
        (state.artifactContents.handoff as { summary?: string } | undefined)
          ?.summary ??
        "Reviewed",
    });
    const row = state.outbox.find((r) => r.key === openKey);
    if (row) {
      row.dependsOn ??= [];
      if (!row.dependsOn.includes(pushKey)) row.dependsOn.push(pushKey);
    }
  }
  if (
    pr?.state !== "open" ||
    pr.headSha !== head ||
    pr.mergeable !== "mergeable" ||
    pr.ci.headSha !== head ||
    pr.ci.conclusion === "failure" ||
    git?.headSha !== head ||
    git.dirty ||
    git.dirtyPaths.length ||
    (git.remoteHeadSha !== head &&
      !state.outbox.some((r) => r.key === pushKey && r.status === "succeeded"))
  )
    return;
  state.review.publicationPending = false;
  c.stage(
    "awaiting_approval",
    "Reviewed head published with no blocking findings",
  );
  c.notify("Review needs approval", `review:${task.reviewRound}`);
}
