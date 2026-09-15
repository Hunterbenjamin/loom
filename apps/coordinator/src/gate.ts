// The send gate (brief §4, design §5.5).
//
// In spike 06 a paste into a pending permission dialog *approved the command* and submitted no
// prompt. The pane host cannot tell: `pasteText` only ever means "bytes written". So every send
// is gated on the provider's own status, read fresh at the moment of the send rather than taken
// from the pass that decided to send. A run that is waiting on a permission or a question, or
// whose status cannot be read at all, receives nothing.

import type { Action, Run } from "@loom/core";
import { deriveStatus } from "@loom/core";
import type { Adapters } from "./adapters.js";
import { observeRun } from "./observe.js";

export type GateDecision =
  | { ok: true; status: Run["status"] }
  | { ok: false; reason: string };

/** Statuses a message may be sent into. Anything else is uncertainty, and uncertainty waits. */
const PERMITTED: Run["status"][] = ["idle", "working"];

/** Statuses a pane prompt answer may be sent into. Allows blocked for interactive dialogs. */
const PANE_PROMPT_PERMITTED: Run["status"][] = ["blocked", "idle"];

export function gateStatus(
  observed: ReturnType<typeof deriveStatus>,
): GateDecision {
  if (!PERMITTED.includes(observed.status))
    return {
      ok: false,
      reason:
        observed.status === "blocked"
          ? `the provider is waiting on ${observed.blockedOn ?? "something"}`
          : `the provider status is ${observed.status}`,
    };
  if (observed.blockedOn !== null)
    return {
      ok: false,
      reason: `the provider is waiting on ${observed.blockedOn}`,
    };
  return { ok: true, status: observed.status };
}

/** Gate for pane prompt answers: allows 'blocked' and 'idle' statuses. */
function gatePanePromptStatus(
  observed: ReturnType<typeof deriveStatus>,
): GateDecision {
  if (!PANE_PROMPT_PERMITTED.includes(observed.status))
    return {
      ok: false,
      reason: `the provider status is ${observed.status}`,
    };
  return { ok: true, status: observed.status };
}

/**
 * Reads the provider again and decides whether this send may happen. Applies to every transport:
 * a Codex turn into a thread waiting on approval is as wrong as a paste into a dialog.
 */
export async function checkSendGate(
  adapters: Adapters,
  now: string,
  run: Run,
  action: Extract<Action, { kind: "send_message" }>,
): Promise<GateDecision> {
  if (run.endedAt) return { ok: false, reason: "the run has ended" };
  if (run.origin !== "loom")
    return { ok: false, reason: "the run is observe-only" };
  if (!run.sessionId)
    return { ok: false, reason: "the run has no recorded session" };
  const observation = await observeRun(adapters, now, run);
  const decision = gateStatus(deriveStatus(run, observation));
  if (!decision.ok) return decision;
  if (action.via === "codex_turn_steer") {
    const provider = observation.provider.ok
      ? observation.provider.value
      : null;
    const turn = provider?.provider === "codex" ? provider.turns.at(-1) : null;
    if (
      !turn ||
      turn.id !== action.expectedTurnId ||
      turn.status !== "inProgress"
    )
      return {
        ok: false,
        reason: "the expected turn is no longer in progress",
      };
  }
  return decision;
}

/**
 * Gate for pane prompt answers: the run must be interactive, Loom-owned, have a pane and session,
 * and be in a state that allows answering prompts (blocked or idle).
 */
export async function checkPanePromptGate(
  adapters: Adapters,
  now: string,
  run: Run,
): Promise<GateDecision> {
  if (run.endedAt) return { ok: false, reason: "the run has ended" };
  if (run.origin !== "loom")
    return { ok: false, reason: "the run is observe-only" };
  if (!run.sessionId)
    return { ok: false, reason: "the run has no recorded session" };
  if (!run.pane) return { ok: false, reason: "the run has no pane" };
  const observation = await observeRun(adapters, now, run);
  return gatePanePromptStatus(deriveStatus(run, observation));
}
