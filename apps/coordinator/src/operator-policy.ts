// Policy v1 is executable code. Events are hints; decisions use fresh owner observations.
import type { HumanCommand, Observations, TaskState } from "@loom/core";
import type { OperatorEvent } from "@loom/store";
import { eventKey } from "./operator-evidence.js";
export const POLICY_ROWS = [
  "permission.allowed",
  "permission.other",
  "headless.retry",
  "headless.exhausted",
  "vanished.rescue",
  "vanished.uncertain",
  "review.escalate",
  "plan.approval",
  "merge.approval",
  "bug.file",
  "fallback",
] as const;
export type PolicyDecision = {
  row: (typeof POLICY_ROWS)[number];
  summary: string;
  command?: HumanCommand;
  file?: true;
  wait?: true;
};

/** Exact repository commands may contain compositions. Built-in allowances never do. */
export function allowedOperatorCommand(
  command: string,
  workflow: Record<string, string>,
): boolean {
  if (Object.values(workflow).includes(command)) return true;
  if (/[\r\n;&|<>`$\\(){}]/.test(command)) return false;
  const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g);
  if (!words || words.join(" ") !== command.trim().replace(/ +/g, " "))
    return false;
  if (
    command === "pnpm install" ||
    command === "pnpm install --frozen-lockfile"
  )
    return true;
  if (words[0] !== "git") return false;
  if (words[1] === "add")
    return (
      words.length > 2 &&
      words
        .slice(2)
        .map((word) =>
          word.startsWith('"') || word.startsWith("'")
            ? word.slice(1, -1)
            : word,
        )
        .every(
          (w) =>
            w === "--" ||
            w === "-A" ||
            w === "--all" ||
            w === "." ||
            (w.length > 0 &&
              !w.startsWith("-") &&
              !w.includes("..") &&
              !w.startsWith("/") &&
              !w.startsWith("~") &&
              !w.startsWith(":")),
        )
    );
  if (words[1] === "commit")
    return (
      words.length === 4 &&
      words[2] === "-m" &&
      /^("[^"\n]+"|'[^'\n]+')$/.test(words[3] ?? "")
    );
  return false;
}
export function attentionOccurrence(state: TaskState): string {
  return eventKey(
    JSON.stringify({
      attention: state.task.attention,
      blocked: state.task.blocked,
      failed: state.task.failed,
      stage: state.task.stage,
      requests: state.runs
        .filter((r) => !r.endedAt)
        .map((r) => [
          r.id,
          r.sessionEpoch,
          r.pendingRequests,
          r.pendingDialog ?? null,
        ]),
      questions: state.questions.map((q) => q.id),
    }),
  );
}
export function operatorPolicy(
  event: OperatorEvent,
  state: TaskState,
  observed: Observations,
  workflow: Record<string, string>,
  retried: boolean,
): PolicyDecision {
  if (["pass_failed", "publish_failed", "stale_process"].includes(event.kind))
    return { row: "bug.file", summary: event.message, file: true };
  // Older ended runs are history, not evidence that the current work vanished.
  const latest = state.runs.at(-1);
  const vanished = latest?.endReason === "vanished" ? latest : null;
  if (vanished) {
    if (state.task.stage !== "in_progress")
      return {
        row: "vanished.uncertain",
        summary:
          "Vanished work outside implementation requires human inspection.",
      };
    const git = observed.git?.ok ? observed.git.value : null;
    if (
      git?.exists &&
      !git.dirty &&
      git.headSha &&
      git.aheadOfBase > 0 &&
      git.branch === state.task.branch &&
      git.path === state.worktree?.path &&
      !state.review &&
      !state.runs.some(
        (r) =>
          !r.endedAt ||
          (r.role === "implementer" && r.endReason === "submitted"),
      )
    ) {
      return {
        row: "vanished.rescue",
        summary:
          "Rescue the clean committed branch; submission and stage remain unchanged.",
        command: {
          type: git.remoteHeadSha === git.headSha ? "open_pr" : "push_branch",
          headSha: git.headSha,
        },
      };
    }
    return {
      row: "vanished.uncertain",
      summary:
        "Vanished run has dirty, missing, uncertain or submitted work. Human inspection is required.",
    };
  }
  if (state.task.stage === "plan_approval")
    return {
      row: "plan.approval",
      summary: "Human approval of the current plan is required.",
    };
  if (state.task.stage === "awaiting_approval")
    return {
      row: "merge.approval",
      summary:
        "Ready for human review and approval of the current head. Operator never approves merges.",
    };
  if (
    ["review_round_cap", "review_not_converging"].includes(
      state.task.blocked?.reason ?? "",
    )
  )
    return {
      row: "review.escalate",
      summary: JSON.stringify({
        review: state.review,
        findings: state.findings.map((f) => ({
          round: f.round,
          title: f.title,
          body: f.body,
          status: f.status,
        })),
      }).slice(0, 7000),
    };
  const failed = state.runs.find(
    (r) =>
      r.mode === "headless" &&
      (!state.runs.some((live) => !live.endedAt && live.id !== r.id) ||
        state.task.failed?.runId === r.id) &&
      (r.status === "failed" ||
        r.endReason === "crashed" ||
        r.endReason === "failed"),
  );
  if (failed) {
    if (failed.retryAt || !state.task.failed)
      return {
        row: "fallback",
        wait: true,
        summary:
          "Core still owns automatic retries; wait for terminal failure.",
      };
    return retried
      ? {
          row: "headless.exhausted",
          summary:
            "The one Operator retry budget reset has already been used for this role and round.",
        }
      : {
          row: "headless.retry",
          summary:
            "Reset the existing retry budget once for this role and round.",
          command: { type: "retry" },
        };
  }
  for (const run of state.runs.filter(
    (r) => !r.endedAt && r.role === "implementer" && r.origin === "loom",
  )) {
    const reading = observed.runs.find((r) => r.runId === run.id)?.provider;
    const provider = reading?.ok ? reading.value : null;
    if (provider?.provider === "codex") {
      const request = provider.pendingRequests[0];
      if (
        request?.kind === "command_approval" &&
        request.command &&
        allowedOperatorCommand(request.command, workflow)
      )
        return {
          row: "permission.allowed",
          summary: `Allow current permission command: ${request.command}`,
          command: {
            type: "answer_provider_request",
            runId: run.id,
            requestId: request.requestId,
            generation: provider.generation,
            decision: "accept",
            answers: null,
          },
        };
      if (request)
        return {
          row: "permission.other",
          summary: `Human decision required: ${request.command ?? request.summary}`,
        };
    }
    // Only native PermissionRequest carries command evidence. PreToolUse and trust are insufficient.
    if (provider?.provider === "claude" && provider.hooks.pendingDialog) {
      const dialog = provider.hooks.pendingDialog;
      if (
        dialog.kind === "permission" &&
        dialog.command &&
        dialog.requestId &&
        provider.agentsEntry?.status === "waiting" &&
        allowedOperatorCommand(dialog.command, workflow)
      )
        return {
          row: "permission.allowed",
          summary: `Allow current permission command: ${dialog.command}`,
          command: {
            type: "answer_pane_prompt",
            runId: run.id,
            choice: 1,
            expectedDialog: {
              requestId: dialog.requestId,
              at: dialog.at,
              command: dialog.command,
              sessionEpoch: run.sessionEpoch,
            },
          },
        };
      return {
        row: "permission.other",
        summary: `Human decision required: ${dialog.command ?? dialog.tool}`,
      };
    }
  }
  return {
    row: "fallback",
    summary: `Human decision required: ${event.message}`,
  };
}
