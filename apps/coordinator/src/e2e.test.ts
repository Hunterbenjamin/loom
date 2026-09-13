// The walking skeleton: one task on a real repository goes Todo through plan, implementation,
// review, one fix round, human approval and merge to Done, through the real coordinator, executor,
// MCP server and store, with the GitHub adapter faked and no agent anywhere.

import { stat } from "node:fs/promises";
import type { Sha, TaskId } from "@loom/core";
import { loadScenarios } from "@loom/fake-agent";
import { afterEach, expect, test, vi } from "vitest";
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
}, 30_000);

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
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run();
  await h.coordinator.settle();

  // The reviewer found nothing blocking the second time, so the human is asked to approve.
  expect(stageOf(h, taskId)).toBe("awaiting_approval");
  const state = h.store.loadTaskState(taskId);
  expect(state.task.prNumber).toBe(1);
  expect(
    state.runs.every((run) => run.mode === "interactive" && run.pane !== null),
  ).toBe(true);
  expect(state.findings.map((f) => f.status)).toEqual(["resolved"]);
  expect(state.task.attention.reasons).toContain("needs_approval");

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

  const done = h.store.loadTaskState(taskId);
  expect(done.runs.every((run) => run.endedAt !== null)).toBe(true);
  for (const run of done.runs) {
    if (run.provider !== "claude" || run.mode !== "headless" || !run.sessionId)
      continue;
    expect(await h.adapters.claude.headlessState(run.sessionId)).toBeNull();
    expect(
      (await h.adapters.claude.listSessions()).some(
        (s) => s.sessionId === run.sessionId,
      ),
    ).toBe(false);
    await h.adapters.claude.closeHeadless(run.sessionId);
  }
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
          "../../../packages/fake-agent/src/fixtures/reviewer-inline.json",
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

test("CI failing after approval voids it and sends the task back to the implementer", async () => {
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
}, 30_000);

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

test("stopCodexServer is called when a task reaches done stage", async () => {
  const h = await harness();
  const taskId = start(h);
  const driver = new ScenarioDriver(h, await scenarios("walking-skeleton"));
  await driver.run();
  await h.coordinator.settle();

  expect(stageOf(h, taskId)).toBe("awaiting_approval");

  // Approve and merge the PR
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

  // Merge the PR to transition to done
  h.github.merge();
  h.coordinator.loop.enqueue(taskId);

  // Spy on the stopCodexServer method
  const stopSpy = vi.spyOn(h.adapters, "stopCodexServer");

  // Settle the loop, which should call stopCodexServer for the task
  await h.coordinator.settle();
  expect(stageOf(h, taskId)).toBe("done");

  // Verify stopCodexServer was called for the task
  expect(stopSpy).toHaveBeenCalledWith(taskId);
}, 30_000);
