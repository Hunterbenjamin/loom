import { describe, expect, it } from "vitest";
import { fixture, now } from "../test/fixtures.js";
import type {
  Input,
  InputId,
  MessageId,
  QuestionId,
  RunObservation,
} from "./index.js";
import { reconcile } from "./index.js";

function interrupted(provider: "codex" | "claude" = "codex") {
  const f = fixture(provider === "codex" ? "in_progress" : "in_review");
  const run = f.state.runs[provider === "codex" ? 1 : 2];
  const observation = f.observations.runs.find(
    (candidate) => candidate.runId === run?.id,
  ) as RunObservation;
  if (!run || !observation.provider.ok || !observation.provider.value)
    throw new Error("Missing fixture run");
  const turnId = provider === "codex" ? "turn-1" : "prompt-1";
  if (observation.provider.value.provider === "codex") {
    observation.provider.value.status = "idle";
    observation.provider.value.turns = [
      {
        id: turnId,
        status: "interrupted",
        error: null,
        userMessageHashes: [],
      },
    ];
  } else {
    const agentsEntry = observation.provider.value.agentsEntry;
    if (!agentsEntry) throw new Error("Missing Claude agents entry");
    observation.provider.value.agentsEntry = {
      ...agentsEntry,
      status: "idle",
      rawStatus: "idle",
    };
    observation.provider.value.hooks.promptSubmits = [
      { promptId: turnId, textHash: "prompt", at: now },
    ];
  }
  const input: Input = {
    id: `restart_interrupted:${run.id}:${turnId}` as InputId,
    receivedAt: now,
    type: "coordinator",
    event: { type: "restart_interrupted", runId: run.id, turnId },
  };
  f.observations.inputs = [input];
  return { ...f, run, observation, turnId };
}

describe("restart continuation", () => {
  it("queues and delivers one continuation for an interrupted Codex turn", () => {
    const f = interrupted();
    const result = reconcile(f.state, f.observations);
    expect(result.next.runs.find((run) => run.id === f.run.id)).toMatchObject({
      inFlightTurnId: null,
      restartInterruption: {
        turnId: f.turnId,
        outcome: "continued",
        decidedAt: now,
      },
    });
    expect(result.next.messages).toContainEqual(
      expect.objectContaining({
        runId: f.run.id,
        purpose: "restart_continuation",
        status: "pending",
        via: "codex_turn_start",
      }),
    );
    expect(
      result.actions.filter((action) => action.kind === "send_message"),
    ).toHaveLength(1);
    const again = reconcile(result.next, f.observations);
    expect(
      again.actions.filter((action) => action.kind === "send_message"),
    ).toHaveLength(0);
    expect(again.next.messages).toHaveLength(result.next.messages.length);
  });

  it.each(["completed", "moved"] as const)(
    "does not continue when the native turn %s",
    (state) => {
      const f = interrupted();
      if (
        !f.observation.provider.ok ||
        f.observation.provider.value?.provider !== "codex"
      )
        throw new Error("Missing Codex observation");
      const turn = f.observation.provider.value.turns[0];
      if (!turn) throw new Error("Missing Codex turn");
      if (state === "completed") turn.status = "completed";
      else turn.id = "turn-2";
      const result = reconcile(f.state, f.observations);
      expect(result.next.messages).toHaveLength(0);
      expect(
        result.next.runs.find((run) => run.id === f.run.id)?.restartInterruption
          ?.outcome,
      ).toBe(state === "completed" ? "completed" : "not_needed");
    },
  );

  it("continues an idle interactive Claude prompt with no Stop", () => {
    const f = interrupted("claude");
    const result = reconcile(f.state, f.observations);
    expect(
      result.next.runs.find((run) => run.id === f.run.id)?.restartInterruption,
    ).toMatchObject({ turnId: f.turnId, outcome: "continued" });
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: "send_message", via: "pane_paste" }),
    );
  });

  it("records a completed Claude prompt without continuing it", () => {
    const f = interrupted("claude");
    if (
      !f.observation.provider.ok ||
      f.observation.provider.value?.provider !== "claude"
    )
      throw new Error("Missing Claude observation");
    f.observation.provider.value.hooks.lastStop = {
      promptId: f.turnId,
      at: now,
      lastAssistantMessage: null,
    };
    const result = reconcile(f.state, f.observations);
    expect(
      result.next.runs.find((run) => run.id === f.run.id)?.restartInterruption
        ?.outcome,
    ).toBe("completed");
    expect(result.next.messages).toHaveLength(0);
  });

  it("waits for queued work and declines after a newer turn starts", () => {
    const f = interrupted();
    f.state.messages.push({
      id: "pending-message" as MessageId,
      runId: f.run.id,
      purpose: "human",
      text: "Already queued",
      textHash: "queued",
      when: "now",
      pendingSince: now,
      status: "pending",
      attempts: 0,
      transportRef: null,
      sentAt: null,
      delivered: null,
    });
    const waiting = reconcile(f.state, f.observations);
    expect(
      waiting.next.runs.find((run) => run.id === f.run.id)?.restartInterruption
        ?.outcome,
    ).toBeNull();
    if (
      !f.observation.provider.ok ||
      f.observation.provider.value?.provider !== "codex"
    )
      throw new Error("Missing Codex observation");
    const turn = f.observation.provider.value.turns.at(-1);
    if (!turn) throw new Error("Missing Codex turn");
    turn.id = "turn-2";
    expect(
      reconcile(waiting.next, f.observations).next.runs.find(
        (run) => run.id === f.run.id,
      )?.restartInterruption?.outcome,
    ).toBe("not_needed");
  });

  it("waits while the run has an unanswered question", () => {
    const f = interrupted();
    f.state.questions.push({
      id: "question-1" as QuestionId,
      taskId: f.state.task.id,
      runId: f.run.id,
      question: "Which option?",
      options: ["one", "two"],
      blocking: true,
      askedAt: now,
      answer: null,
      answeredAt: null,
    });
    const result = reconcile(f.state, f.observations);
    expect(
      result.next.runs.find((run) => run.id === f.run.id)?.restartInterruption
        ?.outcome,
    ).toBeNull();
    expect(result.next.messages).toHaveLength(0);
  });

  it("waits on unknown state and declines work owed by another role", () => {
    const unknown = interrupted();
    unknown.observation.provider = { ok: false, reason: "offline", at: now };
    const waiting = reconcile(unknown.state, unknown.observations);
    expect(
      waiting.next.runs.find((run) => run.id === unknown.run.id)
        ?.restartInterruption?.outcome,
    ).toBeNull();

    const moved = interrupted();
    moved.state.task.stage = "in_review";
    const declined = reconcile(moved.state, moved.observations);
    expect(
      declined.next.runs.find((run) => run.id === moved.run.id)
        ?.restartInterruption?.outcome,
    ).toBe("not_needed");
  });
});
