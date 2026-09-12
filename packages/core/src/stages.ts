import type { Context } from "./context.js";
import { openBlocking } from "./helpers.js";
import type { FindingId } from "./ids.js";

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
    c.notify("Task done", "done");
    return;
  }
  if (task.stage === "done" || task.stage === "canceled") return;
  if (pr?.state === "closed") c.block("pr_closed", "PR closed without merge");
  else if (pr?.state === "open" && task.blocked?.reason === "pr_closed")
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
    } else if (pr.ci.headSha === pr.headSha && pr.ci.conclusion === "failure") {
      c.voidApprovals("ci_failed");
      for (const check of pr.ci.checks.filter(
        (check) =>
          check.status === "completed" &&
          check.conclusion !== null &&
          !["success", "neutral", "skipped"].includes(check.conclusion),
      )) {
        const externalId = check.id ?? `${pr.headSha}:${check.name}`;
        if (
          !state.findings.some(
            (f) => f.source === "ci" && f.externalId === externalId,
          )
        )
          c.finding({
            id: `${task.id}/ci/${externalId}` as FindingId,
            source: "ci",
            externalId,
            severity: "major",
            title: check.name,
            body: `CI failed: ${check.conclusion}`,
            anchor: null,
          });
      }
      c.stage("in_progress", "CI failed on the reviewed head");
      c.fix(`ci:${pr.headSha}`);
    } else {
      const approval = state.approvals.find(
        (a) => a.kind === "merge" && !a.voidedAt,
      );
      if (approval?.kind === "merge") {
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
    c.stage("awaiting_approval", "All blocking findings waived");
    c.notify("Review needs approval", `waived:${c.task.reviewRound}`);
  }
}
