import { StaleCodexRequestError } from "@loom/adapter-codex";
import type { CodexAdapter } from "@loom/core";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing fixture value");
  return value;
}

async function setup() {
  const h = await createHarness();
  open.push(h);
  const taskId = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Approval regression",
    description: "Run tests",
    size: "small",
    providers: { planner: "codex", implementer: "codex", reviewer: "claude" },
  }).task.id;
  h.coordinator.submitHuman(taskId, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const run = required(
    h.store.loadTaskState(taskId).runs.find((r) => r.role === "implementer"),
  );
  const sessionId = required(run.sessionId);
  const request = async () => {
    h.providers.request(sessionId, "approval", "Run tests");
    const snapshot = await h.providers.codex.readThread(sessionId);
    const requestId = required(snapshot.pendingRequests[0]).requestId;
    return {
      type: "answer_provider_request" as const,
      runId: run.id,
      generation: snapshot.generation,
      requestId,
      decision: "accept" as const,
      answers: null,
    };
  };
  return { h, taskId, run, sessionId, request };
}

test("a superseded running answer with an unconsumed failed receipt cannot starve the current accept", async () => {
  const { h, taskId, sessionId, request } = await setup();
  const old = await request();
  h.coordinator.submitHuman(taskId, old);
  await h.coordinator.loop.pass(taskId);
  const stale = required(
    h.store.outbox
      .list(taskId)
      .find((r) => r.kind === "answer_provider_request"),
  );
  const claim = required(h.store.outbox.claim(h.clock.now(), taskId));
  expect(claim.key).toBe(stale.key);
  // The old executor has returned, but core has not consumed its receipt yet.
  h.store.outbox.finish(stale.key, claim.claimVersion, {
    id: "stale-answer-result" as never,
    type: "action_result",
    receivedAt: h.clock.now(),
    key: stale.key,
    result: {
      kind: "answer_provider_request",
      ok: false,
      error: {
        code: "retryable",
        message: "No matching pending Codex request",
      },
    },
  });
  const current = await request();
  expect(current.requestId).not.toBe(old.requestId);
  const send = vi.spyOn(h.providers.codex, "answerRequest");
  const inputId = h.coordinator.submitHuman(taskId, current);
  await h.coordinator.settle();
  expect(send).toHaveBeenCalledExactlyOnceWith({
    threadId: sessionId,
    generation: current.generation,
    requestId: current.requestId,
    decision: "accept",
    answers: null,
  });
  expect(h.store.inputDisposition(taskId, inputId)).toMatchObject({
    accepted: true,
  });
  expect(
    h.store.outbox.list(taskId).find((r) => r.key === stale.key)?.status,
  ).toBe("canceled");
  expect(
    h.store.outbox
      .list(taskId)
      .find(
        (r) =>
          r.action?.kind === "answer_provider_request" &&
          r.action.requestId === current.requestId,
      )?.status,
  ).toBe("canceled");
  // Owner resolution retires the intent before its successful receipt is consumed.
  expect(
    h.store.outbox
      .recent(taskId)
      .find((r) => r.key.endsWith(`:${current.requestId}`))?.result,
  ).toMatchObject({ ok: true });
  expect(h.store.pendingInputs(taskId)).toEqual([]);
  expect(h.store.loadTaskState(taskId).task.attention.reasons).not.toContain(
    "provider_permission",
  );
  expect(h.logs.some((line) => line.includes("Reconcile failed"))).toBe(false);
}, 30_000);

test("the executor classifies a missing Codex request terminally and never retries it", async () => {
  const { h, taskId, request } = await setup();
  const current = await request();
  // The provider resolves between observation and execution. Keep the earlier reading
  // visible so this specifically exercises executor classification and result settlement.
  const send = vi
    .spyOn(h.providers.codex, "answerRequest")
    .mockImplementation(
      async (_req: Parameters<CodexAdapter["answerRequest"]>[0]) => {
        throw new StaleCodexRequestError("No matching pending Codex request");
      },
    );
  h.coordinator.submitHuman(taskId, current);
  await h.coordinator.settle();
  const answers = () =>
    h.store.outbox
      .list(taskId)
      .filter((r) => r.kind === "answer_provider_request");
  expect(answers()).toMatchObject([
    {
      status: "failed",
      error: {
        code: "precondition",
        message: "No matching pending Codex request",
      },
    },
  ]);
  expect(required(answers()[0]).retryAt).toBeUndefined();
  h.clock.advance(300_000);
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();
  expect(send).toHaveBeenCalledTimes(1);
  expect(answers()).toHaveLength(1);
  expect(h.store.pendingInputs(taskId)).toEqual([]);
  expect(h.logs.some((line) => line.includes("Reconcile failed"))).toBe(false);
}, 30_000);
