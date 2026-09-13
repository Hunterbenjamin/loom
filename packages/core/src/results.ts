import type { Context } from "./context.js";
import { later } from "./helpers.js";
import { error } from "./human.js";
import type { McpError } from "./mcp.js";
import type { Input } from "./observations.js";

export function actionResult(
  c: Context,
  input: Extract<Input, { type: "action_result" }>,
): McpError | null {
  const row = c.state.outbox.find((a) => a.key === input.key),
    result = input.result;
  if (!row || row.kind !== result.kind || !row.action)
    return error(
      "guard_failed",
      "Action result must match a recorded action intent",
    );
  if (row.finishedAt) return null; // Duplicate delivery with another inbox ID.
  if (row.status === "canceled") return null; // Late result from superseded work.
  row.status = result.ok ? "succeeded" : "failed";
  row.finishedAt = c.now;
  row.attempts = Math.max(1, row.attempts);
  if (!result.ok) {
    row.error = result.error;
    if (row.action.kind === "send_message" && result.error.code === "fatal") {
      const id = row.action.messageId;
      const target = c.state.messages.find((m) => m.id === id);
      if (target) {
        target.status = "failed";
        target.deliveryAttention = true;
      }
      c.notify("Message refused or failed", input.key);
    }
    if (result.error.code === "fatal")
      c.fail("action_failed", result.error.message);
    else if (result.error.code === "retryable") {
      const retry = c.state.config.retry;
      row.retryAt = later(
        c.now,
        Math.min(
          retry.baseMs * 2 ** (row.attempts - (row.retryBaseAttempt ?? 0) - 1),
          retry.capMs,
        ),
      );
      c.emit(`schedule:${c.task.id}:retry:${row.retryAt}`, {
        kind: "schedule",
        at: row.retryAt,
        why: "retry",
      });
    } else {
      c.emit(`refresh:${input.key}:git`, { kind: "refresh", owner: "git" });
      c.emit(`refresh:${input.key}:github`, {
        kind: "refresh",
        owner: "github",
      });
      if (result.kind === "merge_pr" && c.task.stage === "merging") {
        if (
          c.pr?.state === "open" &&
          c.pr.headSha === c.state.review?.lastReviewedHead
        ) {
          c.voidApprovals("stage_left");
          c.stage("awaiting_approval", "Merge precondition failed");
          c.notify("Merge requires approval again", input.key);
        }
      }
    }
    return null;
  }
  const action = row.action;
  switch (result.kind) {
    case "create_worktree":
      if (action.kind !== "create_worktree") break;
      c.state.worktree = {
        path: result.output.path,
        taskId: c.task.id,
        repoId: c.task.repoId,
        branch: action.branch,
        baseBranch: action.baseBranch,
        baseSha: result.output.baseSha,
        portSlot: null,
        paneWorkspaceId: null,
        createdAt: c.now,
        removedAt: null,
        git: {
          headSha: result.output.headSha,
          dirty: false,
          aheadOfBase: 0,
          at: c.now,
        },
      };
      c.task.worktreePath = result.output.path;
      c.task.branch = action.branch;
      break;
    case "open_workspace":
      if (c.state.worktree)
        c.state.worktree.paneWorkspaceId = result.output.workspaceId;
      break;
    case "start_run": {
      if (action.kind !== "start_run") break;
      const run = c.state.runs.find((r) => r.id === action.runId);
      if (
        !run ||
        run.attempts !== action.attempt ||
        run.sessionEpoch !== action.sessionEpoch ||
        run.endedAt
      )
        break;
      if (
        run.provider === "claude" &&
        run.sessionId !== result.output.sessionId
      ) {
        c.fail(
          "action_failed",
          "Provider returned an unexpected Claude session ID",
          run.id,
        );
        break;
      }
      run.sessionId = result.output.sessionId;
      run.codexGeneration = result.output.codexGeneration;
      run.pane = result.output.pane;
      run.launchedAt = c.now;
      break;
    }
    case "send_message": {
      if (action.kind !== "send_message") break;
      const message = c.state.messages.find((m) => m.id === action.messageId);
      const run = c.state.runs.find((r) => r.id === action.runId);
      if (message && run && !run.endedAt && message.status !== "delivered") {
        message.status = "sent";
        message.transportAttempt = result.output.transportAttempt;
        message.sentAt =
          result.output.transportAttempt?.completedAt ?? input.receivedAt;
        message.transportRef = result.output.transportRef;
      }
      break;
    }
    case "open_pr":
      c.task.prNumber = result.output.number;
      break;
    case "map_findings":
      if (action.kind !== "map_findings") break;
      for (const { findingId, location } of result.output.locations) {
        const finding = c.state.findings.find((f) => f.id === findingId);
        if (
          finding &&
          action.findingIds.includes(findingId) &&
          location.headSha === action.toHeadSha &&
          (!finding.location || location.version > finding.location.version)
        )
          finding.location = location;
      }
      break;
  }
  return null;
}

export function retryActions(c: Context): void {
  if (
    c.task.blocked ||
    c.task.failed ||
    c.task.stage === "done" ||
    c.task.stage === "canceled"
  )
    return;
  for (const row of [...c.state.outbox]) {
    if (!row.retryAt || row.retryAt > c.now || !row.action) continue;
    const action = row.action;
    // Provider launches use the run's monotonic attempt and session epoch.
    if (action.kind === "start_run") {
      const run = c.state.runs.find((r) => r.id === action.runId && !r.endedAt);
      if (run) {
        if (run.mode === "interactive") c.end(run, "vanished");
        else if (
          run.attempts - (run.retryBaseAttempt ?? 0) >=
          c.state.config.retry.maxAttempts
        )
          c.fail("retries_exhausted", "Run launch retries exhausted", run.id);
        else {
          run.status = "failed";
          run.retryAt = row.retryAt;
        }
      }
      row.retryAt = undefined;
      continue;
    }
    if (action.kind === "send_message") {
      const run = c.state.runs.find((r) => r.id === action.runId && !r.endedAt);
      const reading = c.observations.runs.find(
        (o) => o.runId === action.runId,
      )?.provider;
      if (
        !run ||
        !reading?.ok ||
        run.status === "unknown" ||
        run.status === "blocked"
      )
        continue;
    }
    const attempt = row.attempts + 1;
    if (
      attempt - (row.retryBaseAttempt ?? 0) >
      c.state.config.retry.maxAttempts
    ) {
      c.fail("action_failed", `Action retries exhausted: ${row.key}`);
      row.retryAt = undefined;
      continue;
    }
    const base = row.key.replace(/#\d+$/, "");
    c.emit(`${base}#${attempt}`, action);
    const next = c.state.outbox.at(-1);
    if (next) {
      next.attempts = attempt;
      next.retryBaseAttempt = row.retryBaseAttempt;
      row.retriedBy = next.key;
      for (const dependent of c.state.outbox)
        if (dependent.status === "pending" && dependent.key !== next.key)
          dependent.dependsOn = dependent.dependsOn?.map((key) =>
            key === row.key ? next.key : key,
          );
      if (action.kind === "send_message") {
        const message = c.state.messages.find((m) => m.id === action.messageId);
        if (message) message.attempts++;
      }
    }
    row.retryAt = undefined;
  }
}
