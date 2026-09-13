// The faults `@loom/fake-agent` ships scenarios for, run against the real coordinator: a crash and
// its retry, a dropped delivery, a duplicate event, a rate limit, a vanished interactive run and a
// blocking question. Every decision here is core's; the driver only supplies provider events.

import type { ProviderRules, TaskId } from "@loom/core";
import { loadScenarios } from "@loom/fake-agent";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";

// Opt-in allowance for constrained hosts; fake-time assertions and step limits stay unchanged.
const gitTimeout = process.env.LOOM_TEST_SLOW_GIT === "1" ? 120_000 : 30_000;

const scenarios = (name: string) =>
  loadScenarios(new URL(`./fixtures/${name}.json`, import.meta.url));

let open: Harness[] = [];
const harness = async (...args: Parameters<typeof createHarness>) => {
  const value = await createHarness(...args);
  open.push(value);
  return value;
};
afterEach(async () => {
  const all = open;
  open = [];
  for (const value of all) await value.close().catch(() => undefined);
});

const start = (h: Harness, providers?: ProviderRules) => {
  const state = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Change the example",
    description: "Replace the contents of example.txt.",
    providers: providers ?? null,
  });
  h.coordinator.submitHuman(state.task.id, { type: "move", to: "todo" });
  return state.task.id;
};

const load = (h: Harness, id: TaskId) => h.store.loadTaskState(id);

test(
  "a headless run that crashes is retried on the same session",
  async () => {
    const h = await harness({
      config: { runModes: "planner=headless" },
    });
    const taskId = start(h);
    const driver = new ScenarioDriver(h, await scenarios("crash-retry"));
    await driver.run({
      until: () =>
        load(h, taskId).runs.some(
          (r) => r.role === "planner" && r.attempts === 2,
        ),
      maxSteps: 200,
    });
    await h.coordinator.settle();

    const planner = load(h, taskId).runs.find((r) => r.role === "planner");
    expect(planner?.attempts).toBe(2);
    // Decision 10: a retry keeps the row and the session, so the attempt can actually resume.
    expect(planner?.sessionEpoch).toBe(0);
    const recipe = h.coordinator.recipes.get(planner?.id as never);
    expect(recipe?.sessionId).toBe(planner?.sessionId);
    expect(load(h, taskId).task.failed).toBeNull();
  },
  gitTimeout,
);

test(
  "a message the provider never confirms is resent once and then raises attention",
  async () => {
    const h = await harness();
    const taskId = start(h);
    const driver = new ScenarioDriver(h, await scenarios("dropped-delivery"));
    await driver.run({ maxSteps: 300 });
    await h.coordinator.settle();

    const state = load(h, taskId);
    const message = state.messages.find((m) => m.runId.includes("implementer"));
    expect(message).toBeTruthy();
    // Never `delivered`: the transport said yes and the provider never did (design §5.5).
    expect(message?.status).not.toBe("delivered");
    expect(message?.attempts ?? 0).toBeGreaterThanOrEqual(1);
    expect(message?.deliveryAttention).toBe(true);
    expect(state.task.attention.reasons).toContain("provider_input");
  },
  gitTimeout,
);

test(
  "a duplicate event changes nothing and a rate limit blocks until it resets",
  async () => {
    const h = await harness();
    const taskId = start(h);
    const driver = new ScenarioDriver(
      h,
      await scenarios("duplicate-and-cooldown"),
    );
    const blocked: string[] = [];
    await driver.run({
      maxSteps: 400,
      until: () => {
        const flag = load(h, taskId).task.blocked?.reason;
        if (flag) blocked.push(flag);
        return false;
      },
    });
    await h.coordinator.settle();

    // The cooldown held while the provider said so, and released when it reset.
    expect(blocked).toContain("provider_cooling_down");
    const state = load(h, taskId);
    expect(state.task.blocked).toBeNull();
    expect(state.progress?.summary).toBe("Alive");
    // The duplicate hint produced no second run and no second message.
    expect(state.runs.filter((r) => r.role === "implementer")).toHaveLength(1);
  },
  gitTimeout,
);

test(
  "an interactive run that disappears ends vanished and asks for a human",
  async () => {
    const h = await harness();
    const taskId = start(h, {
      planner: "claude",
      implementer: "claude",
      reviewer: "claude",
    });
    const driver = new ScenarioDriver(
      h,
      await scenarios("vanished-interactive"),
    );
    await driver.run({
      until: () => load(h, taskId).runs.some((r) => r.endReason === "vanished"),
      maxSteps: 300,
    });
    await h.coordinator.settle();

    const state = load(h, taskId);
    const implementer = state.runs.find((r) => r.role === "implementer");
    // Decision 21: a human closing the pane and a crash look the same, so Loom never relaunches it.
    expect(implementer?.endReason).toBe("vanished");
    expect(implementer?.attempts).toBe(1);
    expect(state.task.attention.reasons).toContain("run_vanished");
  },
  gitTimeout,
);

test(
  "a blocking question blocks the task until the human answers it",
  async () => {
    const h = await harness();
    const taskId = start(h);
    const driver = new ScenarioDriver(h, await scenarios("question"));
    await driver.run({
      until: () => load(h, taskId).task.blocked?.reason === "question",
      maxSteps: 300,
    });
    await h.coordinator.settle();

    const asked = load(h, taskId);
    expect(asked.task.blocked?.reason).toBe("question");
    expect(asked.task.attention.reasons).toContain("question");
    const question = asked.questions[0];
    expect(question).toBeTruthy();

    h.coordinator.submitHuman(taskId, {
      type: "answer_question",
      questionId: question?.id as never,
      answer: "a",
    });
    await h.coordinator.settle();
    expect(load(h, taskId).task.blocked).toBeNull();
  },
  gitTimeout,
);
