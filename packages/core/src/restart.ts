import type { Context } from "./context.js";
import { read, roleOwesWork } from "./helpers.js";
import type { Input } from "./observations.js";

export function restartInterrupted(
  c: Context,
  input: Extract<Input, { type: "coordinator" }>,
): void {
  const run = c.state.runs.find(
    (candidate) =>
      candidate.id === input.event.runId &&
      candidate.origin === "loom" &&
      !candidate.endedAt,
  );
  if (!run || run.restartInterruption?.turnId === input.event.turnId) return;
  run.restartInterruption = {
    turnId: input.event.turnId,
    recordedAt: input.receivedAt,
    outcome: null,
    decidedAt: null,
  };
}

export function continueInterrupted(c: Context): void {
  for (const run of c.state.runs) {
    const interruption = run.restartInterruption;
    if (!interruption || interruption.outcome) continue;
    const decide = (outcome: "continued" | "completed" | "not_needed") => {
      interruption.outcome = outcome;
      interruption.decidedAt = c.now;
    };
    if (run.endedAt || run.status === "ended") {
      decide("not_needed");
      continue;
    }
    if (run.status === "unknown" || run.status === "starting") continue;
    const observation = c.observations.runs.find((row) => row.runId === run.id);
    const provider = read(observation?.provider);
    if (!provider) continue;
    const turnId =
      provider.provider === "codex"
        ? provider.turns.at(-1)?.id
        : provider.hooks.promptSubmits.at(-1)?.promptId;
    if (!turnId) continue;
    if (turnId !== interruption.turnId) {
      decide("not_needed");
      continue;
    }
    if (
      (provider.provider === "codex" &&
        provider.turns.at(-1)?.status === "completed") ||
      (provider.provider === "claude" &&
        provider.hooks.lastStop?.promptId === turnId)
    ) {
      decide("completed");
      continue;
    }
    if (
      (provider.provider === "codex" &&
        provider.turns.at(-1)?.status === "failed") ||
      run.status === "failed"
    ) {
      decide("not_needed");
      continue;
    }
    if (
      (provider.provider === "codex" &&
        provider.turns.at(-1)?.status === "inProgress") ||
      (provider.provider === "claude" &&
        provider.agentsEntry?.status === "busy") ||
      run.status === "working" ||
      run.status === "blocked"
    )
      continue;
    if (
      c.state.messages.some(
        (message) =>
          message.runId === run.id &&
          (message.status === "pending" || message.status === "sent"),
      ) ||
      c.state.questions.some(
        (question) => question.runId === run.id && question.answer === null,
      )
    )
      continue;
    if (
      roleOwesWork(
        c.task.stage,
        run.role,
        c.task.blocked !== null,
        c.task.failed !== null,
      )
    ) {
      c.message(
        run,
        "restart_continuation",
        turnId,
        "Your previous turn was interrupted by a Loom restart; continue where you left off.",
      );
      c.notify(
        "Interrupted agent turn continued after restart",
        `restart_continued:${run.id}:${turnId}`,
      );
      decide("continued");
    } else decide("not_needed");
  }
}
