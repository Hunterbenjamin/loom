import type { Context } from "./context.js";

export function baseSyncPending(c: Context): boolean {
  return c.state.outbox.some(
    (row) =>
      row.kind === "merge_base" &&
      (row.status === "pending" || row.status === "running" || !!row.retryAt),
  );
}

/** One owner for base movement, before review launch, publication, or approval. */
export function reconcileBaseSync(c: Context): boolean {
  const { state, task, git, pr } = c;
  if (!["ci", "in_review", "awaiting_approval", "merging"].includes(task.stage))
    return false;
  if (baseSyncPending(c)) return true;
  if (task.blocked || task.failed || !state.worktree) return false;
  const head =
    git?.headSha ??
    (task.stage === "ci" ? state.ciGate?.headSha : state.review?.headSha);
  if (!head) return false;
  if (
    (git &&
      (!git.exists ||
        git.path !== state.worktree.path ||
        git.branch !== task.branch)) ||
    state.runs.some((run) => run.origin === "external" && !run.endedAt)
  )
    return true;
  // A fetched local merge-tree result is newer than GitHub's asynchronously recomputed
  // mergeability after a push. Use GitHub only when that local proof is unavailable.
  const conflict =
    git?.conflictsWithBase === true ||
    (pr?.state === "open" &&
      pr.headSha === head &&
      pr.mergeable === "conflicting" &&
      (!git?.currentBaseSha || git.conflictsWithBase == null));
  const behind = !!git?.currentBaseSha && git.behindBase > 0;
  if (!conflict && !behind) {
    // Unknown mergeability is uncertainty, never a reason to spend an implementer turn.
    return (
      pr?.headSha === head &&
      pr.mergeable === "unknown" &&
      git?.conflictsWithBase == null
    );
  }
  if (!conflict && (git?.dirty || git?.dirtyPaths.length)) return true;
  c.voidApprovals("stage_left");
  if (state.review) {
    if (task.stage !== "ci") {
      state.review.nextRoundForBaseSync = true;
      state.review.previousBlocking = null;
    }
    state.review.publicationPending = false;
  }
  const reviewer = c.current("reviewer");
  const retireReviewer =
    reviewer && !reviewer.endedAt ? reviewer.id : undefined;
  state.desiredRun = null;
  for (const run of state.runs)
    if (run.origin === "loom" && !run.endedAt)
      c.end(run, "superseded", false, true);
  if (conflict) {
    state.ciGate = null;
    c.stage(
      "in_progress",
      `Branch conflicts with ${state.worktree.baseBranch}`,
    );
    c.mergeBaseConflict(state.worktree.baseBranch, head, retireReviewer);
  } else if (git?.currentBaseSha && task.branch) {
    state.ciGate = { headSha: head, since: c.now };
    c.stage("ci", `Updating branch with ${state.worktree.baseBranch}`);
    c.emit(`merge_base:${task.id}:${head}:${git.currentBaseSha}`, {
      kind: "merge_base",
      worktreePath: state.worktree.path,
      branch: task.branch,
      baseBranch: state.worktree.baseBranch,
      expectedHeadSha: head,
      baseSha: git.currentBaseSha,
    });
  }
  return true;
}
