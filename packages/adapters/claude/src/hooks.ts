// Claude Code hook payloads: validated at the boundary, stored as receipts, folded on demand.
// Hooks are hints and detail. `claude agents --json` owns live status (spike 02).

import { createHash } from "node:crypto";
import type { ClaudeHookSummary, IsoTime, ProviderSessionId } from "@loom/core";
import { normalizeText } from "@loom/core";
import { z } from "zod";

/** Every event Loom registers. SessionStart is delivered by a command hook; the rest over HTTP. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The tool whose dialog is a question for the human, not a permission (spike 02, §2). */
export const ASK_QUESTION_TOOL = "AskUserQuestion";

/**
 * One hook payload. Loose: Claude Code adds fields per release, and a receipt log that drops
 * them is worse than one that keeps them. Only what the fold reads is typed.
 * Field names are 2.1.268's, not the docs': UserPromptSubmit carries `prompt`, not `user_prompt`.
 */
export const hookPayloadSchema = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  prompt_id: z.string().optional(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  prompt: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  last_assistant_message: z.string().nullish(),
});

export type HookPayload = z.infer<typeof hookPayloadSchema>;

/** A row of the design's `claude_hooks` log. Hooks can't be re-read from Claude, so they're kept. */
export interface HookReceipt {
  seq: number;
  sessionId: ProviderSessionId;
  event: string;
  promptId: string | null;
  receivedAt: IsoTime;
  payload: HookPayload;
}

/**
 * The receipt log. In-memory here; `packages/store` implements the same interface over SQLite
 * so the fold survives a coordinator restart.
 */
export interface HookLog {
  /** Assigns `seq`. Receipts for one session come back in append order. */
  append(receipt: Omit<HookReceipt, "seq">): Promise<HookReceipt>;
  bySession(sessionId: ProviderSessionId): Promise<HookReceipt[]>;
}

export class MemoryHookLog implements HookLog {
  #seq = 0;
  readonly #bySession = new Map<ProviderSessionId, HookReceipt[]>();

  async append(receipt: Omit<HookReceipt, "seq">): Promise<HookReceipt> {
    this.#seq += 1;
    const stored: HookReceipt = { ...receipt, seq: this.#seq };
    const existing = this.#bySession.get(stored.sessionId);
    if (existing) existing.push(stored);
    else this.#bySession.set(stored.sessionId, [stored]);
    return stored;
  }

  async bySession(sessionId: ProviderSessionId): Promise<HookReceipt[]> {
    return [...(this.#bySession.get(sessionId) ?? [])];
  }

  /** Test and restart-pruning support: drop everything older than `before`. */
  prune(before: IsoTime): void {
    const cutoff = Date.parse(before);
    for (const [session, receipts] of this.#bySession) {
      const kept = receipts.filter((r) => Date.parse(r.receivedAt) >= cutoff);
      if (kept.length === 0) this.#bySession.delete(session);
      else this.#bySession.set(session, kept);
    }
  }
}

/**
 * Internal subagents fire SubagentStop on most turns with `agent_type: ""` and no SubagentStart
 * (spike 02, §1). They say nothing about the session, so the fold skips them.
 */
export const isIgnoredSubagentEvent = (payload: HookPayload): boolean =>
  (payload.hook_event_name === "SubagentStart" ||
    payload.hook_event_name === "SubagentStop") &&
  (payload.agent_type ?? "") === "";

/** Matches the design's delivery rule: normalized text, then SHA-256 (§5.5). */
export const textHash = (text: string): string =>
  createHash("sha256").update(normalizeText(text)).digest("hex");

/**
 * Fold receipts for one session, in arrival order.
 *
 * `pendingDialog` follows the contract literally: the latest PreToolUse or PermissionRequest not
 * yet closed. That makes it briefly non-null during any tool call, which is fine — it only tells
 * reconcile *what kind* of dialog is up once `claude agents --json` says `waiting`. Approving a
 * permission fires no hook, so the close comes from PostToolUse and its friends, or from the end
 * of the turn.
 *
 * `sessionStart` and `sessionEnd` are each the last one seen; a resume after a clean exit leaves
 * both set, and their timestamps say which came last.
 */
export function foldHookSummary(receipts: HookReceipt[]): ClaudeHookSummary {
  const summary: ClaudeHookSummary = {
    lastEventAt: null,
    pendingDialog: null,
    promptSubmits: [],
    lastStop: null,
    stopFailure: null,
    sessionStart: null,
    sessionEnd: null,
  };

  for (const receipt of receipts) {
    const { payload, receivedAt } = receipt;
    if (isIgnoredSubagentEvent(payload)) continue;
    summary.lastEventAt = receivedAt;

    switch (receipt.event) {
      case "UserPromptSubmit":
        summary.promptSubmits.push({
          promptId: receipt.promptId ?? "",
          textHash: textHash(payload.prompt ?? ""),
          at: receivedAt,
        });
        break;
      case "PreToolUse":
      case "PermissionRequest": {
        const tool = payload.tool_name ?? "";
        summary.pendingDialog = {
          kind: tool === ASK_QUESTION_TOOL ? "input" : "permission",
          tool,
          at: receivedAt,
        };
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure":
      case "PermissionDenied":
        if (
          summary.pendingDialog &&
          (payload.tool_name === undefined ||
            payload.tool_name === summary.pendingDialog.tool)
        )
          summary.pendingDialog = null;
        break;
      case "Stop":
        summary.pendingDialog = null;
        summary.lastStop = {
          promptId: receipt.promptId ?? "",
          at: receivedAt,
          lastAssistantMessage: payload.last_assistant_message ?? null,
        };
        break;
      case "StopFailure":
        summary.pendingDialog = null;
        summary.stopFailure = {
          error: payload.error ?? payload.message ?? "stop failed",
          at: receivedAt,
        };
        break;
      case "SessionStart":
        summary.pendingDialog = null;
        summary.sessionStart = {
          source: payload.source ?? "unknown",
          at: receivedAt,
        };
        break;
      case "SessionEnd":
        summary.pendingDialog = null;
        summary.sessionEnd = {
          reason: payload.reason ?? "unknown",
          at: receivedAt,
        };
        break;
      default:
        break;
    }
  }

  return summary;
}
