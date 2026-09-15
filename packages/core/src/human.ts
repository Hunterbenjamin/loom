import type { Context } from "./context.js";
import { openBlocking, read } from "./helpers.js";
import type { RunId } from "./ids.js";
import type { McpError } from "./mcp.js";
import type { HumanCommand } from "./observations.js";
import { finishWaivers, reviewBlocked } from "./stages.js";

export const error = (
  code: McpError["code"],
  ...details: string[]
): McpError => ({ code, message: details[0] ?? code, details });
/**
 * Commands whose decision a pass may take against the readings the task was last reconciled with
 * (design §5.1a). Each one's guard reads only Loom's records or readings the human was shown, and
 * its consequences are stage changes, run ends, launches or a merge: intents whose actions still
 * wait for a fresh pass. A command that messages or answers an agent is not here, because delivery
 * in the same pass would act on that agent's old status.
 */
export function decidableFromLastReadings(cmd: HumanCommand): boolean {
  return (
    cmd.type === "edit_task" ||
    cmd.type === "move" ||
    cmd.type === "cancel" ||
    cmd.type === "approve_plan" ||
    cmd.type === "approve" ||
    cmd.type === "waive_finding"
  );
}

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
    case "edit_task":
      if (task.stage !== "backlog") return wrong();
      if (task.version !== cmd.expectedVersion)
        return guard("The issue changed; reopen the editor before saving");
      if (
        !cmd.title.trim() ||
        cmd.title.trim().length > 200 ||
        cmd.description.length > 20000
      )
        return guard(
          "Provide a title up to 200 characters and description up to 20000 characters",
        );
      c.change("Human edited backlog issue", () => {
        task.title = cmd.title.trim();
        task.description = cmd.description;
        task.size = cmd.size;
        task.requirePlanApproval = cmd.requirePlanApproval;
      });
      return null;
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
            body: "Loom rescued committed work from a vanished run. No implementation submission was accepted; human follow-up is required.",
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
          "ci",
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
      c.fix("Human granted another fix round");
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
      if (task.stage !== "awaiting_approval" && task.stage !== "in_review")
        return wrong();
      if (!cmd.findings.length) return guard("Provide at least one finding");
      c.voidApprovals("stage_left");
      for (const finding of cmd.findings)
        c.finding({ ...finding, source: "human", blocking: true });
      // During review the reviewer round in flight is over: the human's findings replace its
      // verdict, so its run is superseded like any other run a stage change leaves behind.
      if (task.stage === "in_review") {
        const reviewer = c.current("reviewer");
        if (reviewer) c.end(reviewer, "superseded", true);
      }
      c.stage("in_progress", "Human requested changes");
      c.fix("Human requested changes");
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
      if (
        cmd.expectedRun &&
        (run.sessionEpoch !== cmd.expectedRun.sessionEpoch ||
          run.attempts !== cmd.expectedRun.attempts)
      )
        return guard("The target run attempt has changed");
      if (
        cmd.expectedRun &&
        state.questions.some(
          (q) => q.runId === run.id && q.blocking && !q.answeredAt,
        )
      )
        return guard("The target run is waiting on a question");
      c.message(run, "human", sequence, cmd.text, {
        when: cmd.when,
        images: cmd.attachmentIds,
      });
      return null;
    }
    case "steer_message": {
      const message = state.messages.find((m) => m.id === cmd.messageId);
      const run = message
        ? state.runs.find(
            (r) => r.id === message.runId && r.origin === "loom" && !r.endedAt,
          )
        : undefined;
      if (!message || !run)
        return guard("Choose a message for a live Loom run");
      if (message.status !== "pending" || message.when !== "after_turn")
        return guard(
          "Only a message still queued for after the turn can steer",
        );
      // Delivery sends it on the next pass: a Codex steer, or Claude's input during the turn.
      message.when = "now";
      message.deliveryReason = null;
      return null;
    }
    case "interrupt_run": {
      const run = state.runs.find(
        (r) => r.id === cmd.runId && r.origin === "loom" && !r.endedAt,
      );
      if (!run) return guard("Choose a live Loom run");
      if (
        run.sessionEpoch !== cmd.expectedRun.sessionEpoch ||
        run.attempts !== cmd.expectedRun.attempts
      )
        return guard("The target run attempt has changed");
      if (run.status !== "working")
        return guard("The target run is not working");
      c.emit(`interrupt_run:${run.id}#${run.attempts}:human:${sequence}`, {
        kind: "interrupt_run",
        runId: run.id,
        reason: "human requested stop",
      });
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
    case "restart_run": {
      const role =
        task.stage === "planning"
          ? "planner"
          : task.stage === "in_progress"
            ? "implementer"
            : task.stage === "in_review"
              ? "reviewer"
              : null;
      if (!role) return wrong();
      const run = c.current(role);
      if (
        !run ||
        run.id !== cmd.runId ||
        run.endReason === "superseded" ||
        state.desiredRun?.replacement
      )
        return guard("The selected run is no longer current; refresh the task");
      if (
        !state.worktree ||
        !c.git?.exists ||
        c.git.path !== state.worktree.path ||
        c.git.branch !== task.branch
      )
        return guard("Read the recorded worktree and branch before restarting");
      if (state.runs.some((r) => r.id !== run.id && !r.endedAt))
        return guard("Another run is still active in this worktree");
      if (
        state.outbox.some(
          (row) =>
            row.status === "running" &&
            row.action &&
            "runId" in row.action &&
            row.action.runId === run.id,
        )
      )
        return guard(
          "An agent action is still in flight; retry restart after it finishes",
        );
      if (
        state.outbox.some(
          (row) =>
            row.status === "failed" &&
            !row.retriedBy &&
            row.action &&
            !("runId" in row.action),
        )
      )
        return guard(
          "Resolve the failed task action before replacing its agent",
        );
      const roleProfile = state.config.roleProfiles?.[role];
      const provider =
        roleProfile?.provider ??
        state.config.providerOverrides?.[role] ??
        task.providers[role];
      c.end(run, "superseded", false, true);
      c.change("Human restarted the run with current agent settings", () => {
        task.failed = null;
        task.providers[role] = provider;
      });
      if (task.blocked?.reason === "provider_cooling_down") c.block(null);
      state.desiredRun = {
        role,
        round: run.round,
        resume: false,
        replacement: {
          runId: `${task.id}/${role}/${run.round}/restart/${sequence}` as RunId,
          previousRunId: run.id,
          provider,
          model: roleProfile?.model ?? state.config.models[provider],
          ...(provider === "codex" &&
          (roleProfile?.reasoningEffort ?? state.config.codexReasoningEffort)
            ? {
                reasoningEffort:
                  roleProfile?.reasoningEffort ??
                  state.config.codexReasoningEffort,
              }
            : {}),
          mode:
            roleProfile?.runMode ??
            state.config.runModes[role] ??
            "interactive",
          access: roleProfile?.access ?? "full",
        },
      };
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
      const role =
        task.stage === "planning"
          ? "planner"
          : task.stage === "in_progress"
            ? "implementer"
            : task.stage === "in_review"
              ? "reviewer"
              : null;
      const pendingReplacement =
        state.desiredRun?.replacement || state.desiredRun?.fresh;
      // A failed action (a push, say) is retried on its own: the runs are healthy and stay.
      const actionOnly = task.failed?.reason === "action_failed" && !failedId;
      const run =
        pendingReplacement || actionOnly
          ? undefined
          : state.runs.findLast(
              (r) =>
                r.origin === "loom" &&
                r.endReason !== "superseded" &&
                (failedId
                  ? r.id === failedId
                  : r.role === role &&
                    (!r.endedAt ||
                      r.endReason === "vanished" ||
                      r.status === "failed")),
            );
      const failedActions = state.outbox.filter(
        (row) =>
          row.status === "failed" &&
          row.action &&
          !row.retryAt &&
          !row.retriedBy,
      );
      if (!run && !failedActions.length)
        return guard(
          pendingReplacement
            ? "A run replacement or retry is already pending"
            : "There is no failed action or run to retry",
        );
      const fresh = run && !run.endedAt && run.status !== "failed";
      if (task.blocked)
        return guard("Resolve the task's blocked reason before retrying");
      if (fresh && run) {
        if (
          !state.worktree ||
          !c.git?.exists ||
          c.git.path !== state.worktree.path ||
          c.git.branch !== task.branch
        )
          return guard("Read the recorded worktree and branch before retrying");
        if (state.runs.some((r) => r.id !== run.id && !r.endedAt))
          return guard("Another run is still active in this worktree");
        if (
          state.outbox.some(
            (row) =>
              row.status === "running" &&
              row.action &&
              "runId" in row.action &&
              row.action.runId === run.id,
          )
        )
          return guard(
            "An agent action is still in flight; retry after it finishes",
          );
      }
      c.change("Human reset retry budget", () => {
        task.failed = null;
      });
      if (actionOnly)
        for (const message of state.messages)
          if (message.status === "pending" && message.attempts === 0) {
            message.pendingSince = c.now;
            message.deliveryAttention = false;
          }
      if (run) {
        if (fresh) {
          const pending = state.messages.filter(
            (m) => m.runId === run.id && m.status === "pending",
          );
          c.end(run, "failed", false, true);
          // Explicit human retry authorizes redelivery. New message IDs keep old transport
          // receipts/outbox rows from confirming or blocking this session's messages.
          for (const message of pending)
            c.message(
              run,
              message.purpose,
              `${sequence}:${message.id}`,
              message.text,
            );
        }
        run.retryBaseAttempt = run.attempts;
        run.retryAt = null;
        c.retireMessages(run, true);
        run.idleSince = null;
        run.endedAt = c.now;
        run.endReason = "failed";
        run.observedAttempt = undefined;
        c.requestRun(run.role, run.round);
        if (fresh && state.desiredRun) state.desiredRun.fresh = true;
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
