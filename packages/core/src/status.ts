import type { Run, RunBlockedOn, RunEndReason, RunStatus } from "./entities.js";
import { read } from "./helpers.js";
import type { RunObservation } from "./observations.js";

export interface StatusReading {
  status: RunStatus;
  blockedOn: RunBlockedOn | null;
  endReason?: RunEndReason;
  nonRetryable?: boolean;
}
export const isRateLimit = (text: string): boolean =>
  /rate.?limit|usage.?limit|usageLimitExceeded|rateLimitExceeded/i.test(text);
export function deriveStatus(
  run: Run,
  observation?: RunObservation,
): StatusReading {
  const status = (
    value: RunStatus,
    blockedOn: RunBlockedOn | null = null,
  ): StatusReading => ({ status: value, blockedOn });
  if (!observation?.provider.ok) return status("unknown");
  const provider = observation.provider.value;
  if (!provider) {
    if (!run.seenAt && observation.resumable !== false)
      return status("starting");
    if (observation.resumable !== false && run.provider === "codex")
      return status("unknown");
    return run.mode === "interactive"
      ? { ...status("ended"), endReason: "vanished" }
      : { ...status("failed"), endReason: "crashed" };
  }
  if (
    provider.provider !== run.provider ||
    (run.sessionId &&
      (provider.provider === "codex"
        ? provider.threadId
        : provider.sessionId) !== run.sessionId)
  )
    return status("unknown");
  if (provider.provider === "codex") {
    const turn = provider.turns.at(-1);
    const error = provider.lastError ?? turn?.error;
    if (provider.status === "notLoaded") return status("unknown");
    if (
      provider.rateLimits?.usageAllowed === false ||
      (error && isRateLimit(error.kind))
    )
      return status("blocked", "rate_limit");
    if (provider.activeFlags.includes("waitingOnApproval"))
      return status("blocked", "permission");
    if (provider.activeFlags.includes("waitingOnUserInput"))
      return status("blocked", "input");
    if (error?.willRetry) return status("working");
    if (
      provider.status === "systemError" ||
      (turn?.status === "failed" && error?.willRetry === false)
    )
      return {
        ...status("failed"),
        nonRetryable: error?.kind === "other" && !error.willRetry,
      };
    if (provider.status === "active" && turn?.status === "inProgress")
      return status("working");
    return provider.status === "idle" ? status("idle") : status("unknown");
  }
  const hooks = provider.hooks;
  // A later provider activity supersedes an old StopFailure receipt.
  const failure = hooks.stopFailure;
  if (failure && (!hooks.lastEventAt || failure.at >= hooks.lastEventAt))
    return isRateLimit(failure.error)
      ? status("blocked", "rate_limit")
      : status("failed");
  if (
    provider.headless?.exited &&
    (provider.headless.exitCode !== 0 || provider.headless.error)
  )
    return status("failed");
  if (provider.agentsEntry?.status === "busy") return status("working");
  if (provider.agentsEntry?.status === "waiting")
    return status(
      "blocked",
      hooks.pendingDialog?.kind === "input" ? "input" : "permission",
    );
  if (provider.agentsEntry?.status === "idle") return status("idle");
  if (provider.agentsEntry) return status("unknown");
  if (hooks.sessionEnd) return { ...status("ended"), endReason: "submitted" };
  if (!run.seenAt && !hooks.sessionStart) {
    const herdr = read(observation.herdr);
    return herdr?.state === "blocked"
      ? status("blocked", "dialog")
      : status("starting");
  }
  return run.mode === "interactive"
    ? { ...status("ended"), endReason: "vanished" }
    : { ...status("failed"), endReason: "crashed" };
}
