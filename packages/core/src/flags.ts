import type { Context } from "./context.js";
import type {
  Attention,
  AttentionReason,
  BlockedFlag,
  FailedFlag,
  Message,
  Question,
  Run,
  Stage,
} from "./entities.js";
import { later, millis, read } from "./helpers.js";
import type { IsoTime, RunId } from "./ids.js";

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

/** Everything the attention rule reads. Pure input: no clock, no I/O, no store. */
export interface AttentionInput {
  now: IsoTime;
  /** The attention the task carries now. Reasons that still hold keep their `since`. */
  previous: Attention;
  stage: Stage;
  blocked: BlockedFlag | null;
  failed: FailedFlag | null;
  budgetMinutes: number | null;
  /** Milliseconds spent in the stages that count against the budget. */
  activeElapsedMs: number;
  /** The task's runs, ended ones included. */
  runs: readonly Run[];
  questions: readonly Question[];
  /** A message whose delivery is uncertain needs the human. */
  messages: readonly Message[];
  stallAfterMs: number;
  unknownGraceMs: number;
}

/** A reason that will start to hold later: re-derive at `at`. */
export interface AttentionSchedule {
  at: IsoTime;
  why: "stall_check" | "poll";
}

export interface AttentionDerivation {
  attention: Attention;
  schedules: AttentionSchedule[];
  /** Runs responsible for each reason, derived alongside the reason itself. */
  reasonRunIds: Partial<Record<AttentionReason, RunId[]>>;
}

/**
 * The one attention rule (docs/design/core.md §3), exported so the UI never re-implements it.
 * Deterministic: the same input always gives the same result.
 */
export function deriveAttention(input: AttentionInput): AttentionDerivation {
  const reasons = new Set<AttentionReason>();
  const schedules: AttentionSchedule[] = [];
  const reasonRunIds: AttentionDerivation["reasonRunIds"] = {};
  const fromRun = (reason: AttentionReason, runId: RunId) => {
    reasons.add(reason);
    const ids = reasonRunIds[reason] ?? [];
    reasonRunIds[reason] = ids;
    if (!ids.includes(runId)) ids.push(runId);
  };
  const terminal = input.stage === "done" || input.stage === "canceled";
  if (!terminal) {
    if (input.stage === "plan_approval") reasons.add("plan_needs_approval");
    if (input.stage === "awaiting_approval") reasons.add("needs_approval");
    for (const question of input.questions)
      if (question.answer === null) fromRun("question", question.runId);
    if (
      input.blocked &&
      !["dependencies", "provider_cooling_down"].includes(input.blocked.reason)
    )
      reasons.add("blocked");
    if (input.failed) {
      reasons.add("failed");
      if (input.failed.runId) fromRun("failed", input.failed.runId);
    }
    for (const run of input.runs) {
      if (run.origin === "external") continue;
      if (run.endReason === "vanished") fromRun("run_vanished", run.id);
      if (run.endedAt) continue;
      if (run.blockedOn === "permission")
        fromRun("provider_permission", run.id);
      // Only emit provider_input if we can actually observe the run.
      // If status is "unknown", emit observability_failure instead.
      if (run.blockedOn === "input" && run.status !== "unknown")
        fromRun("provider_input", run.id);
      if (run.status === "working") {
        const last = run.lastActivityAt ?? run.launchedAt;
        if (last) {
          const at = later(last, input.stallAfterMs);
          if (at <= input.now) fromRun("stalled", run.id);
          else schedules.push({ at, why: "stall_check" });
        }
      }
      if (run.status === "unknown" && run.unknownSince) {
        const at = later(run.unknownSince, input.unknownGraceMs);
        if (at <= input.now) fromRun("observability_failure", run.id);
        else schedules.push({ at, why: "poll" });
      }
    }
    for (const message of input.messages)
      if (message.deliveryAttention) fromRun("provider_input", message.runId);
    if (
      input.budgetMinutes !== null &&
      input.activeElapsedMs > input.budgetMinutes * 60_000
    )
      reasons.add("over_budget");
  }
  const ordered = [...reasons].sort();
  const reasonSince: Partial<Record<AttentionReason, IsoTime>> = {};
  let since: IsoTime | null = null;
  for (const reason of ordered) {
    // A reason that already held keeps its time; `previous.since` covers rows written before
    // `reasonSince` existed, so an additive store migration needs no backfill.
    const held =
      input.previous.reasonSince[reason] ??
      (input.previous.reasons.includes(reason) ? input.previous.since : null) ??
      input.now;
    reasonSince[reason] = held;
    if (!since || held < since) since = held;
  }
  return {
    attention: { reasons: ordered, reasonSince, since },
    schedules,
    reasonRunIds,
  };
}

export function attention(c: Context): void {
  const { task, state } = c;
  const { attention: derived, schedules } = deriveAttention({
    now: c.now,
    previous: task.attention,
    stage: task.stage,
    blocked: task.blocked,
    failed: task.failed,
    budgetMinutes: task.budgetMinutes,
    activeElapsedMs: state.activeElapsedMs,
    runs: state.runs,
    questions: state.questions,
    messages: state.messages,
    stallAfterMs: state.config.stallAfterMs,
    unknownGraceMs: state.config.unknownGraceMs,
  });
  for (const { at, why } of schedules)
    c.emit(`schedule:${task.id}:${why}:${at}`, { kind: "schedule", at, why });
  task.attention = derived;
}

export function budget(c: Context): void {
  const previous = c.state.budgetObservedAt;
  if (budgetStage(c.task.stage))
    c.state.activeElapsedMs =
      c.state.activeElapsedMs + Math.max(0, millis(c.now) - millis(previous));
  c.state.budgetObservedAt = c.now;
}
