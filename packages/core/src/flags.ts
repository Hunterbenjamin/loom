import type { Context } from "./context.js";
import type { AttentionReason } from "./entities.js";
import { later, millis, read } from "./helpers.js";

export const budgetStage = (stage: string): boolean =>
  [
    "planning",
    "plan_approval",
    "in_progress",
    "in_review",
    "awaiting_approval",
  ].includes(stage);
export function reconcileFlags(c: Context): void {
  const { task, state } = c;
  if (task.stage === "done" || task.stage === "canceled") return;
  const question = state.questions.find((q) => q.blocking && q.answer === null);
  if (question && (!task.blocked || task.blocked.reason === "question")) {
    c.block("question", question.question);
    if (task.blocked) task.blocked.questionId = question.id;
  } else if (!question && task.blocked?.reason === "question") c.block(null);
  const role =
    state.desiredRun?.role ??
    (task.stage === "todo"
      ? state.plan?.accepted
        ? "implementer"
        : "planner"
      : null);
  const coolingRun = state.runs.find(
    (r) => !r.endedAt && r.origin === "loom" && r.blockedOn === "rate_limit",
  );
  const provider = coolingRun?.provider ?? (role ? task.providers[role] : null);
  const until = provider
    ? c.observations.capacity.coolingDownUntil[provider]
    : null;
  const snapshot = coolingRun
    ? read(c.observations.runs.find((r) => r.runId === coolingRun.id)?.provider)
    : null;
  const resetsAt =
    snapshot?.provider === "codex" ? snapshot.rateLimits?.resetsAt : null;
  if (
    (coolingRun || (until && until > c.now)) &&
    (!task.blocked || task.blocked.reason === "provider_cooling_down")
  )
    c.block(
      "provider_cooling_down",
      "Provider usage is unavailable",
      resetsAt ?? until,
    );
  if (
    task.blocked?.reason === "provider_cooling_down" &&
    (!task.blocked.until || task.blocked.until <= c.now) &&
    !coolingRun &&
    (!until || until <= c.now)
  ) {
    const relevant = state.runs.filter(
      (r) => !r.endedAt && r.origin === "loom",
    );
    if (
      relevant.every((r) =>
        c.observations.runs.some(
          (o) => o.runId === r.id && o.provider.ok && r.status !== "unknown",
        ),
      )
    )
      c.block(null);
  }
  if (
    task.blocked?.reason === "provider_cooling_down" &&
    task.blocked.until &&
    task.blocked.until > c.now
  )
    c.emit(`schedule:${task.id}:cooldown_end:${task.blocked.until}`, {
      kind: "schedule",
      at: task.blocked.until,
      why: "cooldown_end",
    });
}

export function attention(c: Context): void {
  const { task, state } = c;
  const reasons = new Set<AttentionReason>();
  const terminal = task.stage === "done" || task.stage === "canceled";
  if (!terminal) {
    if (task.stage === "plan_approval") reasons.add("plan_needs_approval");
    if (task.stage === "awaiting_approval") reasons.add("needs_approval");
    if (state.questions.some((q) => q.answer === null)) reasons.add("question");
    if (
      task.blocked &&
      !["dependencies", "provider_cooling_down"].includes(task.blocked.reason)
    )
      reasons.add("blocked");
    if (task.failed) reasons.add("failed");
    for (const run of state.runs) {
      if (run.origin === "external") continue;
      if (run.endReason === "vanished") reasons.add("run_vanished");
      if (run.endedAt) continue;
      if (run.blockedOn === "permission") reasons.add("provider_permission");
      if (run.blockedOn === "input") reasons.add("provider_input");
      if (run.status === "working") {
        const last = run.lastActivityAt ?? run.launchedAt;
        if (last) {
          const at = later(last, state.config.stallAfterMs);
          if (at <= c.now) reasons.add("stalled");
          else
            c.emit(`schedule:${task.id}:stall_check:${at}`, {
              kind: "schedule",
              at,
              why: "stall_check",
            });
        }
      }
      if (run.status === "unknown" && run.unknownSince) {
        const at = later(run.unknownSince, state.config.unknownGraceMs);
        if (at <= c.now) reasons.add("status_unknown");
        else
          c.emit(`schedule:${task.id}:poll:${at}`, {
            kind: "schedule",
            at,
            why: "poll",
          });
      }
    }
    if (state.messages.some((m) => m.deliveryAttention))
      reasons.add("provider_input");
    if (
      task.budgetMinutes !== null &&
      state.activeElapsedMs > task.budgetMinutes * 60_000
    )
      reasons.add("over_budget");
  }
  const ordered = [...reasons].sort();
  const same =
    JSON.stringify(ordered) === JSON.stringify(task.attention.reasons);
  task.attention = {
    reasons: ordered,
    since: ordered.length
      ? same
        ? (task.attention.since ?? c.now)
        : c.now
      : null,
  };
}

export function budget(c: Context): void {
  const previous = c.state.budgetObservedAt;
  if (budgetStage(c.task.stage))
    c.state.activeElapsedMs =
      c.state.activeElapsedMs + Math.max(0, millis(c.now) - millis(previous));
  c.state.budgetObservedAt = c.now;
}
