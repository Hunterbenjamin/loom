import type { Context } from "./context.js";
import type { Message, Run } from "./entities.js";
import { later, read } from "./helpers.js";

function send(c: Context, run: Run, message: Message): void {
  const provider = read(
    c.observations.runs.find((o) => o.runId === run.id)?.provider,
  );
  if (
    !provider ||
    !run.sessionId ||
    run.endedAt ||
    run.origin !== "loom" ||
    run.status === "unknown" ||
    run.status === "starting" ||
    run.status === "blocked" ||
    run.status === "failed"
  )
    return;
  if (
    c.state.messages.some(
      (m) =>
        m.runId === run.id &&
        m.id !== message.id &&
        (m.status === "sent" || (m.status === "pending" && m.attempts > 0)),
    )
  )
    return;
  if (run.status === "idle") {
    if (!c.capacity(run.role)) return;
    c.reserved[run.provider]++;
    c.result.capacityVersion = c.observations.capacity.version;
  }
  const turn = provider.provider === "codex" ? provider.turns.at(-1) : null;
  message.via =
    run.provider === "codex"
      ? run.status === "working"
        ? "codex_turn_steer"
        : "codex_turn_start"
      : run.mode === "interactive"
        ? "pane_paste"
        : "claude_sdk";
  message.expectedTurnId =
    message.via === "codex_turn_steer" ? (turn?.id ?? null) : null;
  if (message.via === "codex_turn_steer" && !message.expectedTurnId) return;
  message.baselineTurnId =
    turn?.id ??
    (provider.provider === "claude"
      ? provider.hooks.promptSubmits.at(-1)?.promptId
      : null) ??
    null;
  const key = `send_message:${message.id}${message.attempts ? `#${message.attempts + 1}` : ""}`;
  c.emit(key, {
    kind: "send_message",
    runId: run.id,
    messageId: message.id,
    via: message.via,
    text: message.text,
    expectedTurnId: message.expectedTurnId,
  });
  message.status = "pending";
  message.attempts++;
}

export function delivery(c: Context): void {
  for (const message of c.state.messages) {
    const run = c.state.runs.find((r) => r.id === message.runId);
    if (!run || run.origin === "external" || run.endedAt) continue;
    const attempt = message.transportAttempt;
    if (
      (message.status === "pending" || message.status === "sent") &&
      attempt &&
      (attempt.sessionId !== run.sessionId ||
        attempt.sessionEpoch !== run.sessionEpoch ||
        attempt.runAttempt !== run.attempts)
    ) {
      // A resumed/replaced run must neither confirm nor replay the previous run's send.
      message.status = "failed";
      message.deliveryAttention = false;
      continue;
    }
    const observation = c.observations.runs.find((o) => o.runId === run.id);
    const provider = read(observation?.provider);
    if (provider && message.status === "sent" && message.sentAt) {
      const receiptSince = attempt?.startedAt ?? message.sentAt;
      const identityMatches =
        provider.provider === run.provider &&
        (provider.provider === "codex"
          ? provider.threadId
          : provider.sessionId) === run.sessionId;
      if (
        identityMatches &&
        observation &&
        observation.provider.at >= receiptSince
      ) {
        if (provider.provider === "codex") {
          const turn = provider.turns.find(
            (t) => t.id === message.transportRef,
          );
          if (turn && message.via === "codex_turn_start")
            message.delivered = {
              via: "codex_turn_started",
              turnId: turn.id,
              at: observation.provider.at,
            };
          if (
            turn &&
            message.via === "codex_turn_steer" &&
            turn.id === message.expectedTurnId &&
            turn.userMessageHashes.includes(message.textHash)
          )
            message.delivered = {
              via: "codex_user_message_item",
              turnId: turn.id,
              at: observation.provider.at,
            };
        } else {
          const receipt = provider.hooks.promptSubmits.find(
            (p) =>
              p.textHash === message.textHash &&
              p.at >= receiptSince &&
              p.at <= observation.provider.at,
          );
          if (receipt)
            message.delivered = {
              via: "claude_user_prompt_submit",
              promptId: receipt.promptId,
              at: receipt.at,
            };
        }
      }
      if (message.delivered) {
        message.status = "delivered";
        message.deliveryAttention = false;
        continue;
      }
    }
    if (message.status === "pending") {
      // A pending transport action already owns this message.
      if (
        !c.state.outbox.some(
          (row) =>
            row.action?.kind === "send_message" &&
            row.action.messageId === message.id,
        )
      )
        send(c, run, message);
    } else if (message.status === "sent" && message.sentAt) {
      const deadline = later(message.sentAt, c.state.config.deliveryTimeoutMs);
      if (deadline > c.now)
        c.emit(`schedule:${c.task.id}:delivery_timeout:${deadline}`, {
          kind: "schedule",
          at: deadline,
          why: "delivery_timeout",
        });
      else {
        const latest =
          provider?.provider === "codex"
            ? (provider.turns.at(-1)?.id ?? null)
            : (provider?.hooks.promptSubmits.at(-1)?.promptId ?? null);
        if (
          provider &&
          run.status === "idle" &&
          latest === (message.baselineTurnId ?? null) &&
          message.attempts < 2 &&
          !c.task.blocked &&
          !c.task.failed
        ) {
          send(c, run, message);
        } else {
          message.deliveryAttention = true;
          c.notify(
            "Message delivery needs inspection",
            `delivery:${message.id}`,
          );
        }
      }
    }
  }
}
