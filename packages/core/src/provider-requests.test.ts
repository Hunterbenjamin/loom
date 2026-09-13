import { describe, expect, it } from "vitest";
import { command, fixed, fixture, now } from "../test/fixtures.js";
import type { Action, Input, OutboxEntry } from "./index.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing fixture value");
  return value;
}

function setup() {
  const f = fixture();
  const run = required(f.state.runs[1]);
  const reading = required(f.observations.runs[1]).provider;
  if (!reading.ok || reading.value?.provider !== "codex")
    throw Error("Codex required");
  const provider = reading.value;
  provider.status = "active";
  provider.activeFlags = ["waitingOnApproval"];
  const request = (requestId: string) => ({
    requestId,
    kind: "command_approval" as const,
    isBlocking: true,
    summary: "Run tests",
    receivedAt: now,
  });
  provider.pendingRequests = [request("4")];
  const answer = (requestId: string, id = requestId) =>
    command(
      {
        type: "answer_provider_request",
        runId: run.id,
        generation: 1,
        requestId,
        decision: "accept",
        answers: null,
      },
      id,
    );
  f.observations.inputs = [answer("4")];
  const queued = fixed(f.state, f.observations);
  const row = required(
    queued.next.outbox.find((r) => r.kind === "answer_provider_request"),
  );
  row.status = "running";
  row.attempts = 1;
  const failure = (
    code: "retryable" | "precondition",
    id = "result",
  ): Extract<Input, { type: "action_result" }> => ({
    id: id as Input["id"],
    receivedAt: now,
    type: "action_result",
    key: row.key,
    result: {
      kind: "answer_provider_request",
      ok: false,
      error: { code, message: "No matching pending Codex request" },
    },
  });
  return { ...f, state: queued.next, row, provider, request, answer, failure };
}

// Every pass also checks the fixed-point contract, including replayed input receipts.
describe("provider request answers", () => {
  it.each(["pending", "running", "failed"] as const)(
    "retires a superseded %s answer before consuming its late result and the current accept",
    (status) => {
      const f = setup();
      f.row.status = status;
      if (status === "failed") {
        f.row.finishedAt = now;
        f.row.retryAt = now;
      }
      f.provider.pendingRequests = [f.request("5")];
      f.observations.inputs = [
        f.failure("retryable"),
        f.answer("5"),
        f.answer("5", "duplicate"),
      ];
      const result = fixed(f.state, f.observations);
      expect(result.next.outbox.find((r) => r.key === f.row.key)).toMatchObject(
        { status: "canceled", retryAt: undefined },
      );
      expect(
        result.actions.filter((a) => a.kind === "answer_provider_request"),
      ).toMatchObject([{ requestId: "5" }]);
      expect(
        result.next.outbox.find(
          (r) =>
            r.action?.kind === "answer_provider_request" &&
            r.action.requestId === "5",
        )?.dependsOn,
      ).toEqual([]);
      expect(result.inputs.every((i) => i.accepted)).toBe(true);
      expect(result.next.task.failed).toBeNull();
    },
  );

  it("keeps concurrent live requests and emits independent answers in one pass", () => {
    const f = setup();
    f.provider.pendingRequests.push(f.request("5"), f.request("6"));
    f.observations.inputs = [f.answer("5"), f.answer("6")];
    const result = fixed(f.state, f.observations);
    expect(result.next.outbox.find((r) => r.key === f.row.key)?.status).toBe(
      "running",
    );
    for (const action of result.actions.filter(
      (a) => a.kind === "answer_provider_request",
    ))
      expect(
        result.next.outbox.find((r) => r.key === action.key)?.dependsOn,
      ).toEqual([]);
  });

  it("removes an older persisted answer dependency when the request disappears", () => {
    const f = setup();
    const action: Action = {
      ...required(f.row.action),
      key: `${f.row.key}:new` as Action["key"],
      requestId: "5",
    } as Action;
    const pending: OutboxEntry = {
      ...f.row,
      key: action.key,
      action,
      status: "pending",
      dependsOn: [f.row.key],
    };
    f.state.outbox.push(pending);
    f.provider.pendingRequests = [f.request("5")];
    f.observations.inputs = [];
    const result = fixed(f.state, f.observations);
    expect(result.next.outbox.find((r) => r.key === pending.key)).toMatchObject(
      { status: "pending", dependsOn: [] },
    );
  });

  it("retires the old generation even when the request ID is reused", () => {
    const f = setup();
    f.provider.generation = 2;
    f.observations.inputs = [];
    expect(
      fixed(f.state, f.observations).next.outbox.find(
        (r) => r.key === f.row.key,
      )?.status,
    ).toBe("canceled");
  });

  it.each(["offline", "notLoaded", "wrong thread", "old reading"])(
    "does not retire an answer on %s evidence",
    (kind) => {
      const f = setup();
      f.provider.pendingRequests = [];
      if (kind === "offline")
        required(f.observations.runs[1]).provider = {
          ok: false,
          at: now,
          reason: "Offline",
        };
      if (kind === "notLoaded") f.provider.status = "notLoaded";
      if (kind === "wrong thread")
        f.provider.threadId = "other" as typeof f.provider.threadId;
      if (kind === "old reading")
        required(f.observations.runs[1]).provider.at =
          "2026-09-11T00:00:00.000Z" as typeof now;
      f.observations.inputs = [];
      expect(
        fixed(f.state, f.observations).next.outbox.find(
          (r) => r.key === f.row.key,
        )?.status,
      ).toBe("running");
    },
  );

  it("settles a missing request precondition without retrying", () => {
    const f = setup();
    f.observations.inputs = [f.failure("precondition")];
    const result = fixed(f.state, f.observations);
    expect(result.next.outbox.find((r) => r.key === f.row.key)).toMatchObject({
      status: "failed",
      error: { code: "precondition" },
    });
    expect(
      result.next.outbox.find((r) => r.key === f.row.key)?.retryAt,
    ).toBeUndefined();
    f.observations.now = "2026-09-12T01:00:00.000Z" as typeof now;
    expect(
      fixed(result.next, f.observations).actions.some(
        (a) => a.kind === "answer_provider_request",
      ),
    ).toBe(false);
    expect(result.next.task.failed).toBeNull();
  });

  it("caps transient answer retries and exposes failure immediately even while task retries are blocked", () => {
    const f = setup();
    let state = f.state;
    let key = f.row.key;
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.observations.inputs = [
        { ...f.failure("retryable", `failure-${attempt}`), key },
      ];
      if (attempt === 3)
        state.task.blocked = {
          reason: "review_round_cap",
          detail: "Review cap",
          since: now,
          until: null,
          questionId: null,
        };
      const failed = fixed(state, f.observations);
      if (attempt === 3) {
        expect(failed.next.task.failed).toMatchObject({
          reason: "action_failed",
          detail: expect.stringContaining("Provider answer retries exhausted"),
        });
        expect(failed.next.task.attention.reasons).toContain("failed");
        expect(
          failed.next.outbox.find((r) => r.key === key)?.retryAt,
        ).toBeUndefined();
        expect(
          failed.actions.some((a) => a.kind === "answer_provider_request"),
        ).toBe(false);
      } else {
        f.observations.now = required(
          failed.next.outbox.find((r) => r.key === key)?.retryAt,
        );
        const retry = fixed(failed.next, f.observations);
        key = required(
          retry.actions.find((a) => a.kind === "answer_provider_request"),
        ).key;
        expect(key).toBe(`${f.row.key}#${attempt + 1}`);
        state = retry.next;
      }
    }
  });
});
