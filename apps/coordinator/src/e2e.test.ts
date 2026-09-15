// The walking skeleton: one task on a real repository goes Todo through plan, implementation,
// review, one fix round, human approval and merge to Done, through the real coordinator, executor,
// MCP server and store, with the GitHub adapter faked and no agent anywhere.

import { stat } from "node:fs/promises";
import type { Sha, TaskId } from "@loom/core";
import { loadScenarios } from "@loom/fake-agent";
import { afterEach, expect, test, vi } from "vitest";
import { codexPerTask } from "./adapters.js";
import { createMcpHost } from "./mcp-host.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";

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

const start = (h: Harness, title = "Change the example") => {
  const state = h.coordinator.createTask({
    repoId: h.repo.id,
    title,
    description: "Replace the contents of example.txt.",
  });
  h.coordinator.submitHuman(state.task.id, { type: "move", to: "todo" });
  return state.task.id;
};

const stageOf = (h: Harness, id: TaskId) =>
  h.store.loadTaskState(id).task.stage;

test("a task runs Todo to Done through plan, review, a fix round and a merge", async () => {
  const h = await harness();
  Object.assign(
    h.adapters,
    codexPerTask(h.dataRoot, () => h.providers.codex),
  );
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run();
  await h.coordinator.settle();

  // The reviewer found nothing blocking the second time, so the human is asked to approve.
  expect(stageOf(h, taskId)).toBe("awaiting_approval");
  const state = h.store.loadTaskState(taskId);
  expect(state.task.prNumber).toBe(1);
  const implementers = state.runs.filter((run) => run.role === "implementer");
  expect(implementers.map((run) => run.round)).toEqual([0, 1]);
  expect(new Set(implementers.map((run) => run.id)).size).toBe(2);
  expect(new Set(implementers.map((run) => run.sessionId)).size).toBe(2);
  expect(implementers.every((run) => run.sessionId !== null)).toBe(true);
  expect(
    state.runs.every((run) => run.mode === "interactive" && run.pane !== null),
  ).toBe(true);
  expect(state.findings.map((f) => f.status)).toEqual(["resolved"]);
  expect(state.task.attention.reasons).toContain("needs_approval");

  expect(h.adapters.codexServerRunning(taskId)).toBe(true);
  const pr = h.github.snapshot();
  const headSha = pr?.headSha as Sha;
  h.github.ci("success");
  const approval = h.coordinator.submitHuman(taskId, {
    type: "approve",
    headSha,
  });
  await h.coordinator.settle();
  expect(h.store.inputDisposition(taskId, approval)).toMatchObject({
    accepted: true,
  });

  // Only an observed merge moves the task: Done is derived from GitHub (decision 7).
  h.github.merge();
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();
  expect(stageOf(h, taskId)).toBe("done");

  expect(h.adapters.codexIfRunning(taskId)).toBeNull();
  expect(h.adapters.codexServerCount()).toBe(0);
  const done = h.store.loadTaskState(taskId);
  expect(done.runs.every((run) => run.endedAt !== null)).toBe(true);
  expect(done.worktree?.removedAt).not.toBeNull();
  if (!done.worktree) throw new Error("Missing worktree history");
  await expect(stat(done.worktree.path)).rejects.toThrow();
  await expect(
    h.git("show-ref", "--verify", `refs/heads/${done.worktree.branch}`),
  ).resolves.toContain(done.worktree.branch);
  expect(done.task.attention.reasons).toEqual([]);
  const transitions = h.store.transitions(taskId).map((t) => t.to);
  expect(transitions).toEqual(
    expect.arrayContaining([
      "todo",
      "planning",
      "in_progress",
      "in_review",
      "awaiting_approval",
      "merging",
      "done",
    ]),
  );
}, 30_000);

test("a fresh fix run reads its compact handoff and current base-to-HEAD diff", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run({
    until: () =>
      h.store
        .loadTaskState(taskId)
        .runs.some((run) => run.role === "implementer" && run.round === 1),
    allowIncomplete: true,
  });
  const state = h.store.loadTaskState(taskId);
  const run = state.runs.find(
    (candidate) => candidate.role === "implementer" && candidate.round === 1,
  );
  if (!run) throw new Error("Missing fresh fix run");
  const { host } = createMcpHost({
    store: h.store,
    adapters: h.adapters,
    recipes: h.coordinator.recipes,
    loop: {} as never,
    workflow: { read: async () => ({}) } as never,
    repo: () => h.repo,
  });
  const context = await host.context(run.id, {});
  if (context.view !== "full") throw new Error("Expected a full context view");
  expect(context.run).toMatchObject({ id: run.id, round: 1 });
  expect(context.brief).toContain("Replace the contents of example.txt");
  expect(context.plan?.goal).toBe("Change the example file");
  expect(context.decisions).toBe("");
  expect(context.fixRound).toMatchObject({
    reason: expect.stringContaining("Review round 1"),
    truncated: false,
    diff: expect.stringContaining("+first implementation"),
  });
  expect(context.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "reviewer",
        blocking: true,
        title: "Fix the value",
      }),
    ]),
  );
}, 30_000);

test.each(["interactive", "headless"] as const)(
  "Claude roles launch %s with correct edit permissions and native initial prompts",
  async (mode) => {
    const h = await harness({
      config: {
        runModes: `planner=${mode},implementer=${mode},reviewer=${mode}`,
        providerOverrides: {
          planner: "claude",
          implementer: "claude",
          reviewer: "claude",
        },
      },
    });
    const args = vi.spyOn(h.providers.claude, "interactiveArgs");
    const headless = vi.spyOn(h.providers.claude, "startHeadless");
    const taskId = start(h);
    const planner = (await scenarios("walking-skeleton"))[0];
    if (!planner) throw new Error("Missing planner fixture");
    const script = [
      planner,
      ...(await loadScenarios(
        new URL(
          "../../../packages/fake-agent/src/fixtures/reviewer-checker.json",
          import.meta.url,
        ),
      )),
    ];
    for (const scenario of script) {
      scenario.agent.provider = "claude";
      scenario.agent.mode = mode;
    }
    await new ScenarioDriver(h, script).run();
    await h.coordinator.settle();
    const state = h.store.loadTaskState(taskId);
    expect(state.task.stage).toBe("awaiting_approval");
    if (mode === "interactive") expect(headless).not.toHaveBeenCalled();
    else
      expect(
        args.mock.calls.filter(([request]) =>
          state.runs.some((run) => run.sessionId === request.sessionId),
        ),
      ).toHaveLength(0);
    const messages = h.store.messages(taskId);
    for (const run of h.store.runs(taskId)) {
      const recipe = h.coordinator.recipes.get(run.id);
      expect(run.mode).toBe(mode);
      expect(run.pane === null).toBe(mode === "headless");
      expect(mode === "interactive" ? args : headless).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: run.sessionId,
          resume: false,
          model: run.model,
          settingsPath: recipe?.settingsPath,
          readOnly: run.role === "planner",
          ...(mode === "headless"
            ? { prompt: expect.stringContaining("get_task_context") }
            : {}),
        }),
      );
      // A role handoff can be queued before launch and serve as that run's first message.
      if (mode === "interactive")
        expect(messages.find((m) => m.runId === run.id)).toMatchObject({
          status: "delivered",
        });
      expect(
        h.paneHost.writes.some(
          (write) => write.ref.paneId === run.pane?.paneId,
        ),
      ).toBe(mode === "interactive");
    }
  },
  30_000,
);

test("every run's launch recipe is persisted privately before anything starts", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run({ until: () => stageOf(h, taskId) === "in_progress" });

  const recipes = h.coordinator.recipes.all();
  expect(recipes.length).toBeGreaterThan(0);
  for (const recipe of recipes) {
    expect(recipe.token.length).toBeGreaterThanOrEqual(16);
    // The token is never an argument: it rides in the environment and the MCP config.
    expect(recipe.args.join(" ")).not.toContain(recipe.token);
    expect(recipe.env.LOOM_MCP_TOKEN).toBe(recipe.token);
    // The environment is an allowlist, so an inherited name that breaks resuming cannot reach it.
    expect(recipe.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    // Private files live outside the repository.
    expect(recipe.settingsPath ?? h.dataRoot).toContain(h.dataRoot);
    const info = await stat(
      `${h.coordinator.recipes.directory(recipe.runId)}/recipe.json`,
    );
    expect(info.mode & 0o777).toBe(0o600);
  }
  const planner = recipes.find((r) => r.role === "planner");
  expect(planner?.sessionId).toBeTruthy();
  const implementer = recipes.find((r) => r.role === "implementer");
  expect(implementer?.mode).toBe("interactive");
  expect(implementer?.executable).toBeTruthy();
}, 30_000);

test("a token maps to its run, and a different run's token cannot reach this task", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run({ until: () => stageOf(h, taskId) === "in_progress" });

  const planner = h.coordinator.recipes.all().find((r) => r.role === "planner");
  expect(planner).toBeTruthy();
  // The planner's run ended when its plan was accepted, so its token is stale, not unknown.
  expect(h.coordinator.resolveRunToken("not-a-token")).toBeNull();
  expect(h.coordinator.resolveRunToken("")).toBeNull();
  expect(h.coordinator.resolveRunToken(planner?.token ?? "")).toMatchObject({
    runId: planner?.runId,
    active: false,
  });
  const implementer = h.coordinator.recipes
    .all()
    .find((r) => r.role === "implementer");
  expect(h.coordinator.resolveRunToken(implementer?.token ?? "")).toMatchObject(
    {
      runId: implementer?.runId,
      active: true,
    },
  );
}, 30_000);

test("a live run's token stays valid when the coordinator's recipe drifts from the store", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run({ until: () => stageOf(h, taskId) === "in_progress" });
  const implementer = h.coordinator.recipes
    .all()
    .find((r) => r.role === "implementer");
  if (!implementer) throw new Error("Missing implementer recipe");
  // The store is the only authority on liveness. A recipe whose attempt counter is behind or
  // ahead of the run (a restart mid-relaunch, a second coordinator on the same directory) must
  // not refuse an agent that the store says is current: that left a rebased branch unsubmittable.
  await h.coordinator.recipes.save({
    ...implementer,
    attempt: implementer.attempt + 5,
  });
  expect(h.coordinator.resolveRunToken(implementer.token)).toMatchObject({
    runId: implementer.runId,
    active: true,
  });
}, 30_000);

test("CI failing after approval voids it and starts a fresh implementer", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run();
  await h.coordinator.settle();
  expect(stageOf(h, taskId)).toBe("awaiting_approval");

  // CI is still running, so the merge is armed with `--auto` and the task waits in `merging`.
  const headSha = h.github.snapshot()?.headSha as Sha;
  const approval = h.coordinator.submitHuman(taskId, {
    type: "approve",
    headSha,
  });
  await h.coordinator.settle();
  expect(h.store.inputDisposition(taskId, approval)).toMatchObject({
    accepted: true,
  });
  expect(stageOf(h, taskId)).toBe("merging");
  expect(h.github.snapshot()?.autoMergeEnabled).toBe(true);

  // Decision 5: a CI failure needs a fix, so the task goes back to `in_progress` with a finding.
  h.github.ci("failure");
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();
  const state = h.store.loadTaskState(taskId);
  expect(state.task.stage).toBe("in_progress");
  expect(state.findings.some((f) => f.source === "ci" && f.blocking)).toBe(
    true,
  );
  expect(state.approvals.every((a) => a.voidedAt !== null)).toBe(true);
  expect(
    state.runs.find((run) => run.role === "implementer" && run.round === 2)
      ?.fixReason,
  ).toContain("CI failed on reviewed head");
});

test("a human push to the branch after review voids the approval and re-reviews", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run();
  await h.coordinator.settle();

  const headSha = h.github.snapshot()?.headSha as Sha;
  const approval = h.coordinator.submitHuman(taskId, {
    type: "approve",
    headSha,
  });
  await h.coordinator.settle();
  expect(h.store.inputDisposition(taskId, approval)).toMatchObject({
    accepted: true,
  });

  const worktree = h.store.loadTaskState(taskId).worktree;
  expect(worktree).toBeTruthy();
  const pushed = await h.commitIn(
    worktree?.path as string,
    { "example.txt": "a human edited this\n" },
    "Human push",
  );
  h.github.setHead(pushed);
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();

  const state = h.store.loadTaskState(taskId);
  expect(state.task.stage).toBe("in_review");
  expect(state.approvals.every((a) => a.voidedAt !== null)).toBe(true);
}, 30_000);
