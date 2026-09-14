import { ciFindings } from "./ci-gate.js";
import type { Context } from "./context.js";
import { openBlocking } from "./helpers.js";
import type { FindingId } from "./ids.js";
import { publishReview } from "./review-publication.js";

export function reconcileStages(c: Context): void {
  const { task, state, pr } = c;
  if (pr) task.prNumber = pr.number;
  if (pr?.state === "merged" && task.stage !== "done") {
    c.voidApprovals("stage_left");
    for (const run of state.runs) c.end(run, "task_done");
    state.desiredRun = null;
    c.cancelPending();
    c.block(null);
    c.stage("done", "PR merged on GitHub");
    c.notify("Issue done", "done");
    return;
  }
  if (task.stage === "done" || task.stage === "canceled") return;
  if (pr?.state === "closed") {
    c.block("pr_closed", "PR closed without merge");
    const policyApproval = state.approvals.find(
      (approval) =>
        approval.kind === "merge" &&
        approval.approvedBy === "policy" &&
        !approval.voidedAt,
    );
    if (
      policyApproval &&
      (task.stage === "awaiting_approval" || task.stage === "merging")
    ) {
      c.voidApprovals("stage_left");
      if (task.stage === "merging")
        c.stage("awaiting_approval", "Pull request closed before policy merge");
    }
  } else if (pr?.state === "open" && task.blocked?.reason === "pr_closed")
    c.block(null);
  if (pr?.state === "open") {
    for (const comment of pr.comments) {
      if (
        state.findings.some(
          (f) => f.source === "github" && f.externalId === comment.id,
        )
      )
        continue;
      const blocking = pr.reviews.some(
        (r) => r.id === comment.reviewId && r.state === "changes_requested",
      );
      c.finding({
        id: `${task.id}/github/${comment.id}` as FindingId,
        severity: blocking ? "major" : "minor",
        blocking,
        title: "GitHub comment",
        body: comment.body,
        source: "github",
        externalId: comment.id,
        anchor: null,
      });
    }
  }
  if (
    (task.stage === "awaiting_approval" || task.stage === "merging") &&
    pr?.state === "open"
  ) {
    if (
      state.review?.lastReviewedHead &&
      pr.headSha !== state.review.lastReviewedHead
    ) {
      c.voidApprovals("new_commit");
      if (state.worktree)
        c.emit(`map_findings:${task.id}:${pr.headSha}`, {
          kind: "map_findings",
          worktreePath: state.worktree.path,
          toHeadSha: pr.headSha,
          findingIds: state.findings.map((f) => f.id),
        });
      c.stage("in_review", "PR head changed");
      c.review(pr.headSha);
    } else if (pr.mergeable === "conflicting" && state.worktree) {
      c.voidApprovals("stage_left");
      c.stage(
        "in_progress",
        `Branch conflicts with ${state.worktree.baseBranch}`,
      );
      c.rebase(state.worktree.baseBranch, pr.headSha);
    } else if (pr.ci.headSha === pr.headSha && pr.ci.conclusion === "failure") {
      c.voidApprovals("ci_failed");
      ciFindings(c, pr.ci);
      c.stage("in_progress", "CI failed on the reviewed head");
      c.fix(`ci:${pr.headSha}`);
    } else {
      const approval = state.approvals.find(
        (a) => a.kind === "merge" && !a.voidedAt,
      );
      if (approval?.kind === "merge") {
        if (
          approval.approvedBy === "policy" &&
          (pr.ci.headSha !== pr.headSha ||
            !["success", "none"].includes(pr.ci.conclusion) ||
            pr.mergeable !== "mergeable" ||
            Date.parse(c.now) - Date.parse(c.observations.github?.at ?? "") >
              state.config.githubPollMs * 2)
        ) {
          c.voidApprovals("stage_left");
          if (task.stage === "merging")
            c.stage(
              "awaiting_approval",
              "Automatic merge guards are no longer current",
            );
        }
        if (
          task.stage === "merging" &&
          state.outbox.some(
            (row) =>
              row.key === `merge_pr:${approval.id}` &&
              row.status === "failed" &&
              row.error?.code === "precondition",
          )
        ) {
          c.voidApprovals("stage_left");
          c.stage(
            "awaiting_approval",
            "Merge precondition failed; fresh PR head is unchanged",
          );
          c.notify(
            "Merge requires approval again",
            `precondition:${approval.id}`,
          );
        }
        const snapshot = state.findings
          .map(({ id, status, severity }) => ({ id, status, severity }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (
          state.config.sha256(JSON.stringify(snapshot)) !==
          approval.findings.hash
        ) {
          c.voidApprovals("findings_changed");
          if (task.stage === "merging")
            c.stage("awaiting_approval", "Findings changed since approval");
        }
      }
    }
  }
  publishReview(c);
  // Automatic policy creates the same exact-head approval as a human, only after every guard is
  // current. Pending/unknown CI waits here; the executor's existing exact-SHA precondition remains
  // the final authority at merge time.
  if (
    task.stage === "awaiting_approval" &&
    (task.mergePolicy === "auto-all" ||
      (task.mergePolicy === "auto-small" && task.size === "small")) &&
    pr?.state === "open" &&
    state.review?.lastReviewedHead === pr.headSha &&
    !openBlocking(state.findings) &&
    pr.ci.headSha === pr.headSha &&
    ["success", "none"].includes(pr.ci.conclusion) &&
    Date.parse(c.now) - Date.parse(c.observations.github?.at ?? "") <=
      state.config.githubPollMs * 2 &&
    pr.mergeable === "mergeable" &&
    !state.approvals.some(
      (approval) => approval.kind === "merge" && !approval.voidedAt,
    )
  ) {
    c.approval(pr.headSha, "policy");
    c.stage("merging", "Merge policy approved exact reviewed head");
  }
  if (task.stage === "todo") {
    const missing = task.blockedBy.filter(
      (id) =>
        !c.observations.dependencies.some((d) => d.taskId === id && d.merged),
    );
    if (
      missing.length &&
      (!task.blocked || task.blocked.reason === "dependencies")
    )
      c.block(
        "dependencies",
        `Waiting for merged dependencies: ${missing.join(", ")}`,
      );
    else if (!missing.length && task.blocked?.reason === "dependencies")
      c.block(null);

    // For small tasks, auto-generate a plan and skip the planning stage
    if (task.size === "small" && !state.plan) {
      const autoPlan = {
        goal: task.title,
        nonGoals: [],
        steps: task.description
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => ({
            title: line.trim(),
            detail: "",
          })),
        areas: [],
        acceptanceCriteria: [],
        testPlan: [],
        risks: [],
        openQuestions: [],
        suggestedImplementer: null,
      };
      const version = c.artifact("plan", autoPlan);
      state.plan = { ...autoPlan, version, accepted: true };
    }

    const role = state.plan?.accepted ? "implementer" : "planner";
    if (!task.blocked && !task.failed && !missing.length && c.capacity(role)) {
      c.stage(
        role === "planner" ? "planning" : "in_progress",
        "Dependencies and capacity allow start",
      );
      c.requestRun(role);
      c.files();
    }
  }
}

export function reviewBlocked(c: Context): boolean {
  return (
    c.task.stage === "in_review" &&
    (c.task.blocked?.reason === "review_round_cap" ||
      c.task.blocked?.reason === "review_not_converging")
  );
}
export function finishWaivers(c: Context): void {
  if (reviewBlocked(c) && openBlocking(c.state.findings) === 0) {
    c.block(null);
    if (c.state.review?.lastReviewedHead) {
      c.state.review.publicationPending = true;
      publishReview(c);
    }
  }
}
