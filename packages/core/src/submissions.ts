import type { Context } from "./context.js";
import { openBlocking } from "./helpers.js";
import { error } from "./human.js";
import type { McpError, TestResultInput } from "./mcp.js";
import type { Input } from "./observations.js";
import type { McpReply } from "./reconcile.js";

export function submission(
  c: Context,
  input: Extract<Input, { type: "mcp" }>,
): McpReply | McpError {
  const { call } = input,
    { task, state, pr, git } = c;
  const run = state.runs.find((r) => r.id === input.runId);
  if (!run || run.taskId !== task.id || run.origin !== "loom")
    return error("unknown_run", "The run does not belong to this task");
  if (
    run.endedAt ||
    c.current(run.role)?.id !== run.id ||
    task.stage === "canceled" ||
    task.stage === "done"
  )
    return error("stale_run", "The run has ended or was superseded");
  const allowed = {
    submit_plan: ["planner", "planning"],
    submit_for_review: ["implementer", "in_progress"],
    submit_review: ["reviewer", "in_review"],
    resolve_finding: ["implementer", "in_progress"],
  } as const;
  if (call.tool in allowed) {
    const pair = allowed[call.tool as keyof typeof allowed];
    if (run.role !== pair[0] || task.stage !== pair[1])
      return error(
        "wrong_stage",
        `${call.tool} requires ${pair[0]} in ${pair[1]}`,
      );
  }
  const guard = (...details: string[]) => error("guard_failed", ...details);
  const testHead =
    call.tool === "submit_review"
      ? call.input.reviewedSha
      : call.tool === "submit_for_review"
        ? call.input.headSha
        : git?.headSha;
  if ("testResults" in call.input && call.input.testResults.length && !testHead)
    return guard("Read the current git HEAD before recording test results");
  const tests = (values: TestResultInput[]) => {
    if (values.length)
      c.artifact(
        "test_results",
        [
          ...((state.artifactContents.test_results as unknown[]) ?? []),
          ...values.map((value) => ({
            ...value,
            headSha: testHead,
            ranAt: c.now,
            runId: run.id,
          })),
        ],
        run,
      );
  };
  switch (call.tool) {
    case "submit_plan": {
      const plan = call.input.plan;
      if (
        !plan ||
        typeof plan.goal !== "string" ||
        !plan.goal.trim() ||
        !Array.isArray(plan.steps) ||
        !plan.steps.length ||
        !Array.isArray(plan.acceptanceCriteria) ||
        !plan.acceptanceCriteria.length ||
        plan.acceptanceCriteria.some((v) => !v.trim()) ||
        plan.steps.some((s) => !s.title?.trim())
      )
        return error(
          "invalid_input",
          "Plan needs a goal, at least one named step, and an acceptance criterion",
        );
      if (!task.requirePlanApproval && !c.capacity("implementer", run))
        return guard(
          "Implementer capacity unavailable or provider cooling down",
        );
      const version = c.artifact("plan", plan, run);
      state.plan = { ...plan, version, accepted: !task.requirePlanApproval };
      c.end(run, "submitted");
      const next = task.requirePlanApproval ? "plan_approval" : "in_progress";
      c.stage(next, "Planner submitted valid plan");
      if (task.requirePlanApproval)
        c.notify("Plan needs approval", `plan:${version}`);
      else {
        c.files();
        c.requestRun("implementer");
      }
      return { tool: call.tool, value: { planVersion: version, next } };
    }
    case "report_progress": {
      const progress = call.input;
      if (
        progress.stepIndex !== null &&
        (!Number.isInteger(progress.stepIndex) ||
          progress.stepIndex < 0 ||
          !state.plan ||
          progress.stepIndex >= state.plan.steps.length)
      )
        return guard("stepIndex must name a step in the current plan");
      state.progress = {
        runId: run.id,
        summary: progress.summary,
        stepIndex: progress.stepIndex,
        at: c.now,
      };
      if (progress.decisions.length)
        c.artifact(
          "decisions",
          [
            ...((state.artifactContents.decisions as string[]) ?? []),
            ...progress.decisions,
          ],
          run,
        );
      tests(progress.testResults);
      c.files();
      return { tool: call.tool, value: { recorded: true } };
    }
    case "ask_human": {
      if (!call.input.question.trim())
        return error("invalid_input", "Provide a question");
      if (state.questions.some((q) => q.id === call.questionId))
        return guard("Question ID already exists");
      state.questions.push({
        id: call.questionId,
        taskId: task.id,
        runId: run.id,
        ...call.input,
        askedAt: c.now,
        answer: null,
        answeredAt: null,
      });
      if (call.input.blocking) {
        c.block("question", call.input.question);
        if (task.blocked) task.blocked.questionId = call.questionId;
      }
      return {
        tool: call.tool,
        value: { questionId: call.questionId, delivery: "message" },
      };
    }
    case "resolve_finding": {
      const { findingId, resolution, note, commitSha } = call.input;
      const finding = state.findings.find(
        (f) => f.id === findingId && f.taskId === task.id,
      );
      const failures: string[] = [];
      if (finding?.status !== "open")
        failures.push("Finding must be open and belong to this task");
      if (
        resolution === "fixed" &&
        (!commitSha ||
          !git?.exists ||
          (git.headSha !== commitSha &&
            !git.reachableCommits.includes(commitSha)))
      )
        failures.push(
          "A fixed finding needs a commit reachable from the current HEAD",
        );
      if (failures.length || !finding) return guard(...failures);
      finding.status = resolution === "fixed" ? "addressed" : "disputed";
      finding.resolution = { by: "implementer", note, commitSha, at: c.now };
      finding.updatedAt = c.now;
      return { tool: call.tool, value: { status: finding.status } };
    }
    case "submit_for_review": {
      const failures: string[] = [];
      if (!git?.exists || git.headSha !== call.input.headSha)
        failures.push("Read git and submit the current worktree HEAD");
      if (!git || git.dirty || git.dirtyPaths.length)
        failures.push(
          `Clean the worktree (ignored files excluded): ${git?.dirtyPaths.join(", ") || "dirty paths unavailable; refresh git status"}`,
        );
      if (!git || git.aheadOfBase <= 0)
        failures.push("Commit changes ahead of the base branch");
      for (const finding of state.findings)
        if (finding.status === "addressed" && !finding.resolution?.commitSha)
          failures.push(`Finding ${finding.id} needs its fixing commit`);
      if (!state.worktree || !task.branch)
        failures.push("Create and record the worktree and branch first");
      if (failures.length || !state.worktree || !task.branch)
        return guard(...failures);
      c.artifact(
        "handoff",
        {
          from: "implementer",
          to: "reviewer",
          headSha: call.input.headSha,
          ...call.input.handoff,
        },
        run,
      );
      tests(call.input.testResults);
      c.stage("in_review", "Implementation submitted for review");
      c.review(call.input.headSha);
      c.emit(`push_branch:${task.id}:${call.input.headSha}`, {
        kind: "push_branch",
        worktreePath: state.worktree.path,
        branch: task.branch,
        expectedHeadSha: call.input.headSha,
      });
      if (!task.prNumber)
        c.emit(`open_pr:${task.id}:${task.branch}`, {
          kind: "open_pr",
          repoId: task.repoId,
          branch: task.branch,
          baseBranch: state.worktree.baseBranch,
          title: task.title,
          body: call.input.summary,
        });
      return { tool: call.tool, value: { round: task.reviewRound } };
    }
    case "submit_review": {
      const review = call.input,
        failures: string[] = [];
      if (
        !state.review ||
        review.reviewedSha !== state.review.headSha ||
        !pr ||
        pr.state !== "open" ||
        pr.headSha !== review.reviewedSha
      )
        failures.push("Review must match the round head and fresh PR head");
      const required =
        state.review?.verdictIds ??
        state.findings
          .filter((f) => f.status === "addressed" || f.status === "disputed")
          .map((f) => f.id);
      for (const id of required)
        if (review.verdicts.filter((v) => v.findingId === id).length !== 1)
          failures.push(`Provide exactly one verdict for ${id}`);
      for (const verdict of review.verdicts)
        if (!required.includes(verdict.findingId))
          failures.push(`Unexpected verdict for ${verdict.findingId}`);
      if (
        call.drafts.length !== review.findings.length ||
        new Set(call.drafts.map((d) => d.id)).size !== call.drafts.length
      )
        failures.push("Each finding needs a unique persisted draft");
      for (let i = 0; i < review.findings.length; i++) {
        const finding = review.findings[i],
          draft = call.drafts[i];
        if (draft && state.findings.some((f) => f.id === draft.id))
          failures.push(`Finding ID ${draft.id} already exists`);
        if (finding?.location) {
          const a = draft?.anchor,
            l = finding.location;
          if (
            !a ||
            a.headSha !== review.reviewedSha ||
            (l.side === "new" ? a.newPath : a.oldPath) !== l.path ||
            a.side !== l.side ||
            a.startLine !== l.startLine ||
            a.endLine !== l.endLine ||
            l.startLine < 1 ||
            l.endLine < l.startLine ||
            !(l.side === "new" ? a.newBlobOid : a.oldBlobOid)
          )
            failures.push(
              `Finding ${i} needs a verified anchor in the reviewed commit`,
            );
        }
      }
      if (failures.length) return guard(...failures);
      // Validate the proposed result before mutating durable findings.
      const projected = state.findings.map((f) => ({ ...f }));
      let reopened = false;
      for (const verdict of review.verdicts) {
        const finding = projected.find((f) => f.id === verdict.findingId);
        if (finding) {
          finding.status = verdict.status === "resolved" ? "resolved" : "open";
          if (verdict.status === "reopened") {
            finding.reopenCount++;
            reopened = true;
          }
          finding.resolution = {
            by: "reviewer",
            note: verdict.note,
            commitSha: review.reviewedSha,
            at: c.now,
          };
          finding.updatedAt = c.now;
        }
      }
      const count =
        openBlocking(projected) +
        review.findings.filter(
          (f) => f.severity === "major" || f.severity === "blocker",
        ).length;
      if (
        count === 0 &&
        (pr?.mergeable !== "mergeable" ||
          pr.ci.headSha !== review.reviewedSha ||
          pr.ci.conclusion === "failure")
      )
        return guard(
          "Confirm the PR is mergeable and CI for the reviewed head is not failing",
        );
      state.findings = projected;
      review.findings.forEach((finding, i) => {
        const draft = call.drafts[i];
        if (draft)
          c.finding({
            id: draft.id,
            anchor: draft.anchor,
            severity: finding.severity,
            title: finding.title,
            body: finding.body,
            createdByRunId: run.id,
          });
      });
      tests(review.testResults);
      c.artifact("findings", state.findings, run);
      c.end(run, "submitted");
      const previous = state.review?.previousBlocking;
      if (state.review) {
        state.review.lastReviewedHead = review.reviewedSha;
        state.review.previousBlocking = count;
      }
      let next: "awaiting_approval" | "in_progress" | "blocked";
      if (count === 0) {
        next = "awaiting_approval";
        c.stage(next, "Review has no blocking findings");
        c.notify("Review needs approval", `review:${task.reviewRound}`);
      } else if (
        task.reviewRound >= task.reviewRoundCap ||
        reopened ||
        (previous != null && count >= previous)
      ) {
        next = "blocked";
        c.block(
          task.reviewRound >= task.reviewRoundCap
            ? "review_round_cap"
            : "review_not_converging",
          "Review needs human direction",
        );
        c.notify(
          "Review needs human direction",
          `review-blocked:${task.reviewRound}`,
        );
      } else {
        next = "in_progress";
        c.stage(next, "Review requests a converging fix round");
        c.fix(`round:${task.reviewRound}`);
      }
      return {
        tool: call.tool,
        value: { round: task.reviewRound, openBlocking: count, next },
      };
    }
  }
}
