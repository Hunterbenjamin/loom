// Main queues recorded messages; it never runs a provider turn or waits for a reply.
import { createHash, randomUUID } from "node:crypto";
import type { InputId, IsoTime, Run, TaskId } from "@loom/core";
import { deriveStatus } from "@loom/core";
import { messageAgentResultSchema, messageAgentSchema } from "@loom/mcp";
import type { Store } from "@loom/store";
import { z } from "zod";
import type { Adapters } from "./adapters.js";
import { type GateDecision, gateStatus } from "./gate.js";
import { observeRun } from "./observe.js";

const receiptSchema = z.object({
  request: z.string(),
  result: messageAgentResultSchema,
});
type Result = z.output<typeof messageAgentResultSchema>;
const refused = (reason: string): Result => ({ delivered: "refused", reason });

async function admission(
  adapters: Adapters,
  now: IsoTime,
  run: Run,
): Promise<GateDecision> {
  if (run.endedAt) return { ok: false, reason: "the run has ended" };
  if (run.origin !== "loom")
    return { ok: false, reason: "the run is observe-only" };
  if (!run.sessionId)
    return { ok: false, reason: "the run has no recorded session" };
  // A slow or unavailable owner refuses promptly; Main never joins the provider's work queue.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observeRun(adapters, now, run).then((observation) =>
        gateStatus(deriveStatus(run, observation)),
      ),
      new Promise<GateDecision>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              reason: "provider status was not available promptly",
            }),
          600,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function messageAgent(
  deps: {
    store: Store;
    adapters: Adapters;
    now(): IsoTime;
    enqueue(taskId: TaskId): void;
  },
  repoId: string,
  raw: Record<string, unknown>,
): Promise<Result> {
  const input = messageAgentSchema.parse(raw);
  const request = JSON.stringify([
    input.to.kind,
    "taskId" in input.to ? input.to.taskId : null,
    input.to.kind === "run"
      ? input.to.runId
      : input.to.kind === "task"
        ? input.to.role
        : null,
    input.text,
  ]);
  const id = `main-message:${createHash("sha256")
    .update(JSON.stringify([repoId, input.idempotencyKey ?? randomUUID()]))
    .digest("hex")}`;
  const prior = () => {
    const saved = deps.store.mainMessages.get(id, receiptSchema);
    return saved
      ? saved.request === request
        ? saved.result
        : refused("idempotencyKey was already used for a different message")
      : null;
  };
  const replay = prior();
  if (replay) return replay;
  const taskId = "taskId" in input.to ? input.to.taskId : null;
  const task = taskId
    ? deps.store.tasks().find((t) => t.id === taskId && t.repoId === repoId)
    : null;
  let result: Result = { delivered: "queued" };
  let run: Run | undefined;
  if (taskId && !task)
    result = refused("Task is outside Main's repository or does not exist");
  if (task) {
    const state = deps.store.loadTaskState(task.id);
    const to = input.to;
    const candidates = state.runs.filter((r) =>
      to.kind === "run"
        ? r.id === to.runId
        : to.kind === "task" && r.role === to.role && !r.endedAt,
    );
    run = candidates.length === 1 ? candidates[0] : undefined;
    if (!run) result = refused("Choose exactly one live run of that role");
    else if (
      state.questions.some(
        (q) => q.runId === run?.id && !q.answeredAt && q.blocking,
      )
    )
      result = refused("the run is waiting on a question");
    else {
      const gate = await admission(deps.adapters, deps.now(), run);
      if (!gate.ok) result = refused(gate.reason);
    }
  }
  return deps.store.mainMessages.atomic(() => {
    const replay = prior();
    if (replay) return replay;
    if (task && run && result.delivered === "queued") {
      const state = deps.store.loadTaskState(task.id);
      const current = state.runs.find((r) => r.id === run?.id);
      if (
        !current ||
        current.endedAt ||
        current.sessionEpoch !== run.sessionEpoch ||
        current.attempts !== run.attempts
      )
        result = refused("the run changed while checking its provider");
      else if (
        state.questions.some(
          (q) => q.runId === run?.id && q.blocking && !q.answeredAt,
        )
      )
        result = refused("the run is waiting on a question");
      else
        deps.store.enqueueInput(task.id, {
          id: id as InputId,
          receivedAt: deps.now(),
          type: "human",
          command: {
            type: "send_message",
            runId: run.id,
            text: `Message from Main (a question or heads-up, not a work assignment):\n${input.text}`,
            expectedRun: {
              sessionEpoch: run.sessionEpoch,
              attempts: run.attempts,
            },
          },
        });
    }
    if (task)
      deps.store.mainMessages.note({
        id,
        taskId: task?.id ?? null,
        repoId,
        author: "main",
        at: deps.now(),
        eventId: id,
        row: "main.message",
        outcome: result.delivered,
        body: input.text,
        forHuman: false,
        occurrence: request,
      });
    deps.store.mainMessages.set(id, { request, result });
    if (task) deps.enqueue(task.id);
    return result;
  });
}
