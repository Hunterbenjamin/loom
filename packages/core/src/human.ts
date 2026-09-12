import type { Context } from "./context.js";
import { openBlocking, read } from "./helpers.js";
import type { McpError } from "./mcp.js";
import type { HumanCommand } from "./observations.js";
import { finishWaivers, reviewBlocked } from "./stages.js";

export const error = (
  code: McpError["code"],
  ...details: string[]
): McpError => ({ code, message: details[0] ?? code, details });
export function human(
  c: Context,
  cmd: HumanCommand,
  sequence: string,
): McpError | null {
  const { task, state, pr } = c;
  const wrong = () =>
    error("wrong_stage", `${cmd.type} is not allowed in ${task.stage}`);
  const guard = (...details: string[]) => error("guard_failed", ...details);
  switch (cmd.type) {
    case "push_branch":
    case "open_pr": {
      if (task.stage !== "in_progress") return wrong();
      const git = c.git;
      if (
        !state.worktree ||
        !task.branch ||
        !git?.exists ||
        git.path !== state.worktree.path ||
        git.branch !== task.branch ||
        git.dirty ||
        git.aheadOfBase < 1 ||
        git.headSha !== cmd.headSha
      )
        return guard(
          "Rescue requires the recorded clean branch and exact committed HEAD ahead of base",
        );
      if (
        state.review ||
        state.runs.some((r) => !r.endedAt) ||
        !state.runs.some((r) => r.endReason === "vanished") ||
        state.runs.some(
          (r) => r.role === "implementer" && r.endReason === "submitted",
        )
      )
        return guard(
          "Rescue requires vanished work without a submission or a live run",
        );
      if (cmd.type === "push_branch")
        c.emit(`rescue:push:${task.id}:${cmd.headSha}`, {
          kind: "push_branch",
          worktreePath: state.worktree.path,
          branch: task.branch,
          expectedHeadSha: cmd.headSha,
        });
      else {
        if (git.remoteHeadSha !== cmd.headSha)
          return guard("Confirm push of this HEAD before opening a PR");
        if (!task.prNumber)
          c.emit(`rescue:pr:${task.id}:${cmd.headSha}`, {
            kind: "open_pr",
            rescueHeadSha: cmd.headSha,
            repoId: task.repoId,
            branch: task.branch,
            baseBranch: state.worktree.baseBranch,
            title: task.title,
            body: "Operator rescued committed work from a vanished run. No implementation submission was accepted; human follow-up is required.",
          });
      }
      return null;
    }
    case "move":
      if (cmd.to === "todo" && task.stage === "backlog") {
        c.stage("todo", "Human queued task");
        return null;
      }
      if (
        cmd.to !== "backlog" ||
        ![
          "todo",
          "planning",
          "plan_approval",
          "in_progress",
          "in_review",
          "awaiting_approval",
        ].includes(task.stage)
      )
        return wrong();
      c.voidApprovals("stage_left");
      for (const run of state.runs) c.end(run, "superseded", true);
      state.desiredRun = null;
      c.cancelPending();
      c.stage("backlog", "Human parked task");
      return null;
    case "cancel":
      if (task.stage === "done" || task.stage === "canceled") return wrong();
      c.voidApprovals("stage_left");
      for (const run of state.runs) c.end(run, "canceled", true);
      state.desiredRun = null;
      c.cancelPending();
      c.block(null);
      c.stage("canceled", cmd.reason);
      return null;
    case "reopen":
      if (task.stage !== "canceled") return wrong();
      if (pr === undefined || pr?.state === "merged")
        return guard("Read GitHub and confirm the PR is not merged");
      c.stage("backlog", "Human reopened task");
      return null;
    case "approve_plan":
      if (task.stage !== "plan_approval") return wrong();
      if (!state.plan || state.plan.version !== cmd.planVersion)
        return guard("Approve the latest plan version");
      if (!c.capacity("implementer"))
        return guard(
          "Implementer capacity unavailable or provider cooling down",
        );
      state.plan.accepted = true;
      c.approval();
      c.stage("in_progress", "Human approved plan");
      c.files();
      c.requestRun("implementer");
      return null;
    case "reject_plan":
      if (task.stage !== "plan_approval") return wrong();
      if (state.plan) state.plan.accepted = false;
      c.voidApprovals("plan_changed");
      c.stage("planning", "Human rejected plan");
      c.requestRun("planner");
      {
        const run = c.current("planner");
        if (run)
          c.message(
            run,
            "plan_feedback",
            sequence,
            `Plan feedback:\n${cmd.feedback}`,
          );
      }
      return null;
    case "grant_review_round":
      if (!reviewBlocked(c)) return wrong();
      if (task.blocked?.reason === "review_round_cap") task.reviewRoundCap++;
      c.block(null);
      c.stage("in_progress", "Human granted fix round");
      c.fix(sequence);
      return null;
    case "waive_finding": {
      if (task.stage === "done" || task.stage === "canceled") return wrong();
      const finding = state.findings.find((f) => f.id === cmd.findingId);
      if (!finding || finding.taskId !== task.id)
        return guard("Finding must belong to this task");
      finding.status = "waived";
      finding.resolution = {
        by: "human",
        note: cmd.note,
        at: c.now,
        commitSha: null,
      };
      finding.updatedAt = c.now;
      finishWaivers(c);
      return null;
    }
    case "approve": {
      if (task.stage !== "awaiting_approval") return wrong();
      const failures: string[] = [];
      if (
        pr?.state !== "open" ||
        cmd.headSha !== pr.headSha ||
        cmd.headSha !== state.review?.lastReviewedHead
      )
        failures.push("Approve the current PR head after it has been reviewed");
      if (openBlocking(state.findings))
        failures.push("Resolve or waive all blocking findings");
      if (
        !pr ||
        pr.ci.headSha !== cmd.headSha ||
        !["success", "pending", "none"].includes(pr.ci.conclusion)
      )
        failures.push("Read CI for this head; it must not be failing");
      if (pr?.mergeable !== "mergeable")
        failures.push("Confirm the PR is mergeable");
      if (failures.length) return guard(...failures);
      c.approval(cmd.headSha);
      c.stage("merging", "Human approved exact head");
      return null;
    }
    case "request_changes":
      if (task.stage !== "awaiting_approval") return wrong();
      if (!cmd.findings.length) return guard("Provide at least one finding");
      c.voidApprovals("stage_left");
      for (const finding of cmd.findings)
        c.finding({ ...finding, source: "human", blocking: true });
      c.stage("in_progress", "Human requested changes");
      c.fix(sequence);
      return null;
    case "answer_question": {
      const question = state.questions.find(
        (q) => q.id === cmd.questionId && q.answer === null,
      );
      if (!question) return guard("Question is unknown or already answered");
      const run = state.runs.find(
        (r) => r.id === question.runId && r.origin === "loom",
      );
      if (!run) return guard("Question run is unavailable");
      question.answer = cmd.answer;
      question.answeredAt = c.now;
      c.message(
        run,
        "answer",
        sequence,
        `Answer to ${question.id}: ${cmd.answer}`,
      );
      if (task.blocked?.reason === "question") c.block(null);
      return null;
    }
    case "send_message": {
      const run = state.runs.find(
        (r) => r.id === cmd.runId && r.origin === "loom" && !r.endedAt,
      );
      if (!run) return guard("Choose a live Loom run");
      c.message(run, "human", sequence, cmd.text);
      return null;
    }
    case "answer_provider_request": {
      const run = state.runs.find(
        (r) => r.id === cmd.runId && r.origin === "loom" && !r.endedAt,
      );
      const provider = read(
        c.observations.runs.find((r) => r.runId === cmd.runId)?.provider,
      );
      if (
        !run ||
        provider?.provider !== "codex" ||
        provider.generation !== cmd.generation ||
        !provider.pendingRequests.some((r) => r.requestId === cmd.requestId)
      )
        return guard(
          "Request must exist on the current Codex connection generation",
        );
      c.emit(
        `answer_provider_request:${run.id}:${cmd.generation}:${cmd.requestId}`,
        {
          kind: "answer_provider_request",
          runId: cmd.runId,
          requestId: cmd.requestId,
          generation: cmd.generation,
          decision: cmd.decision,
          answers: cmd.answers,
        },
      );
      return null;
    }
    case "answer_pane_prompt": {
      const run = state.runs.find(
        (r) => r.id === cmd.runId && r.origin === "loom" && !r.endedAt,
      );
      if (!run) return guard("Choose a live Loom run");
      c.emit(
        `answer_pane_prompt:${run.id}${cmd.expectedDialog ? `:${cmd.expectedDialog.sessionEpoch}:${cmd.expectedDialog.requestId}:${cmd.expectedDialog.at}` : ""}`,
        {
          kind: "answer_pane_prompt",
          runId: cmd.runId,
          choice: cmd.choice,
          text: cmd.text,
          ...(cmd.expectedDialog ? { expectedDialog: cmd.expectedDialog } : {}),
        },
      );
      return null;
    }
    case "retry": {
      if (
        task.stage === "done" ||
        task.stage === "canceled" ||
        task.stage === "backlog"
      )
        return wrong();
      const failedId = task.failed?.runId;
      const run = state.runs.find(
        (r) =>
          r.origin === "loom" &&
          (failedId
            ? r.id === failedId
            : r.endReason === "vanished" || r.status === "failed"),
      );
      if (!task.failed && !run)
        return guard("There is no failed action or run to retry");
      c.change("Human reset retry budget", () => {
        task.failed = null;
      });
      if (run) {
        run.retryBaseAttempt = run.attempts;
        run.retryAt = null;
        run.endedAt = c.now;
        run.endReason = "failed";
        run.observedAttempt = undefined;
        c.requestRun(run.role, run.round);
      }
      for (const row of state.outbox)
        if (
          row.status === "failed" &&
          row.action &&
          !row.retryAt &&
          !row.retriedBy
        ) {
          row.retryBaseAttempt = row.attempts;
          row.retryAt = c.now;
        }
      return null;
    }
  }
}
