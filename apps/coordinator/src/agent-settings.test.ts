import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadScenarios } from "@loom/fake-agent";
import { expect, test, vi } from "vitest";
import { writeCodexHomeConfig } from "./launch.js";
import { createHarness, ScenarioDriver } from "./test-support.js";

const updateRole = (
  h: Awaited<ReturnType<typeof createHarness>>,
  role: "planner" | "implementer" | "reviewer",
  value: {
    provider?: "codex" | "claude";
    model?: string;
    reasoningEffort?: "medium" | null;
  },
) => {
  const scope = { kind: "repository" as const, repoId: h.repo.id };
  const current = h.store.settings.read(scope);
  h.store.settings.update({
    scope,
    expectedVersion: current.version,
    data: {
      ...current.data,
      roles: {
        ...current.data.roles,
        [role]: { ...current.data.roles?.[role], ...value },
      },
    },
    actor: "test",
    changedAt: h.clock.now(),
    changes: [],
  });
};

test.each(["interactive", "headless"] as const)(
  "all Codex roles use configured settings with %s launches and recovery",
  async (mode) => {
    let h = await createHarness({
      config: {
        providerOverrides: {
          planner: "codex",
          implementer: "codex",
          reviewer: "codex",
        },
        models: { codex: "gpt-5.6-sol", claude: "fake-claude" },
        codexReasoningEffort: "medium",
        runModes: `planner=${mode},implementer=${mode},reviewer=${mode}`,
      },
    });
    try {
      const startThread = vi.spyOn(h.providers.codex, "startThread");
      const startTurn = vi.spyOn(h.providers.codex, "startTurn");
      const created = h.coordinator.createTask({
        repoId: h.repo.id,
        title: "Configured agents",
        description: "Change example.txt",
      });
      h.coordinator.submitHuman(created.task.id, { type: "move", to: "todo" });
      const scenarios = await loadScenarios(
        new URL("./fixtures/walking-skeleton.json", import.meta.url),
      );
      for (const scenario of scenarios) {
        scenario.agent.provider = "codex";
        scenario.agent.mode = mode;
      }
      await new ScenarioDriver(h, scenarios).run();
      await h.coordinator.settle();
      const state = h.store.loadTaskState(created.task.id);
      expect(state.task.stage).toBe("awaiting_approval");
      expect(new Set(state.runs.map((r) => r.role))).toEqual(
        new Set(["planner", "implementer", "reviewer"]),
      );
      for (const run of state.runs) {
        expect(run).toMatchObject({
          provider: "codex",
          mode,
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        });
        expect(run.pane === null).toBe(mode === "headless");
        expect(h.coordinator.recipes.get(run.id)).toMatchObject({
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        });
      }
      expect(startThread).toHaveBeenCalled();
      const history = h.store.runs(created.task.id);
      for (const [index, [request]] of startThread.mock.calls.entries()) {
        const thread = await startThread.mock.results[index]?.value;
        const run = history.find((run) => run.sessionId === thread?.threadId);
        expect(run).toBeDefined();
        expect(request).toMatchObject({
          model: "gpt-5.6-sol",
          config: { model_reasoning_effort: "medium" },
          sandbox: run?.role === "planner" ? "read-only" : "danger-full-access",
        });
      }
      expect(startTurn).toHaveBeenCalled();
      for (const [request] of startTurn.mock.calls)
        expect(request).toMatchObject({
          model: "gpt-5.6-sol",
          effort: "medium",
        });

      const launch = h.store.outbox
        .list(created.task.id)
        .find((row) => row.action?.kind === "start_run")?.action;
      if (launch?.kind !== "start_run")
        throw new Error("Missing stored launch");
      expect(launch.reasoningEffort).toBe("medium");
      await writeCodexHomeConfig(h.dataRoot, launch);
      const config = await readFile(
        join(h.dataRoot, "codex", created.task.id, "codex-home", "config.toml"),
        "utf8",
      );
      expect(config).toContain('model = "gpt-5.6-sol"');
      expect(config).toContain('model_reasoning_effort = "medium"');
      // The app-server is shared by the task's runs: no run's token belongs in its config.
      expect(config).not.toContain("mcp_servers");
      const reviewerLaunch = h.store.outbox
        .list(created.task.id)
        .find(
          (row) =>
            row.action?.kind === "start_run" && row.action.role === "reviewer",
        )?.action;
      if (reviewerLaunch?.kind !== "start_run")
        throw new Error("Missing reviewer launch");
      await writeCodexHomeConfig(h.dataRoot, reviewerLaunch);
      expect(
        await readFile(
          join(
            h.dataRoot,
            "codex",
            created.task.id,
            "codex-home",
            "config.toml",
          ),
          "utf8",
        ),
      ).toContain('sandbox_mode = "danger-full-access"');
      h = await h.restart();
      for (const run of h.store.loadTaskState(created.task.id).runs)
        expect(run.reasoningEffort).toBe("medium");
    } finally {
      await h.close();
    }
  },
  30_000,
);

test("restart replaces Claude with Sol on the same dirty worktree and retires first", async () => {
  let h = await createHarness({
    config: {
      models: { codex: "gpt-5.6-sol", claude: "old-claude" },
      codexReasoningEffort: "medium",
    },
  });
  try {
    const created = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Replace planner",
      description: "Continue existing work",
    });
    h.coordinator.submitHuman(created.task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    const before = h.store.loadTaskState(created.task.id);
    const old = before.runs.find((r) => r.role === "planner");
    if (!old || !before.worktree) throw new Error("Missing planner");
    expect(old.provider).toBe("claude");
    const file = join(before.worktree.path, "unfinished.txt");
    await writeFile(file, "keep this work\n");
    updateRole(h, "planner", {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(old.mode).toBe("interactive");
    expect(old.pane).not.toBeNull();
    const closed = vi.spyOn(h.paneHost, "closePane");
    const closeHeadless = vi.spyOn(h.providers.claude, "closeHeadless");
    const start = vi.spyOn(h.providers.codex, "startThread");
    h.coordinator.submitHuman(created.task.id, {
      type: "restart_run",
      runId: old.id,
    });
    await h.coordinator.settle();
    const state = h.store.loadTaskState(created.task.id);
    const replacement = state.runs.find(
      (r) => r.id !== old.id && r.role === "planner",
    );
    expect(replacement).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      worktreePath: old.worktreePath,
    });
    expect(replacement?.sessionId).not.toBe(old.sessionId);
    expect(state.task.stage).toBe("planning");
    expect(await readFile(file, "utf8")).toBe("keep this work\n");
    expect(closed).toHaveBeenCalledWith(old.pane);
    expect(closeHeadless).not.toHaveBeenCalled();
    expect(closed.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0] ?? 0,
    );
    if (!replacement) throw new Error("Missing replacement");
    expect(h.coordinator.recipes.get(replacement.id)).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    const count = start.mock.calls.length;
    h.coordinator.submitHuman(created.task.id, {
      type: "restart_run",
      runId: old.id,
    });
    await h.coordinator.settle();
    expect(start).toHaveBeenCalledTimes(count);
    h = await h.restart();
    expect(
      h.store
        .loadTaskState(created.task.id)
        .runs.find((r) => r.id === replacement?.id),
    ).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
  } finally {
    await h.close();
  }
}, 30_000);

test("replacement waits through failed retirement and restart, then uses its captured model", async () => {
  let h = await createHarness({
    config: {
      models: { codex: "old-codex", claude: "fake-claude" },
      codexReasoningEffort: "medium",
    },
  });
  try {
    const created = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Continue implementation",
      description: "Keep the existing work",
      size: "small",
    });
    h.coordinator.submitHuman(created.task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    const before = h.store.loadTaskState(created.task.id);
    const old = before.runs.find((r) => r.role === "implementer");
    if (!old?.pane) throw new Error("Missing interactive run");
    updateRole(h, "implementer", { model: "gpt-5.6-sol" });
    const close = vi
      .spyOn(h.paneHost, "closePane")
      .mockRejectedValueOnce(new Error("temporary pane failure"));
    const start = vi.spyOn(h.providers.codex, "startThread");
    h.coordinator.submitHuman(created.task.id, {
      type: "restart_run",
      runId: old.id,
    });
    await h.coordinator.settle();
    expect(close).toHaveBeenCalledWith(old.pane);
    expect(start).not.toHaveBeenCalled();
    expect(
      h.store.loadTaskState(created.task.id).desiredRun?.replacement?.model,
    ).toBe("gpt-5.6-sol");
    h = await h.restart();
    h.clock.advance(20_000);
    await h.coordinator.settle();
    const state = h.store.loadTaskState(created.task.id);
    const replacement = state.runs.find(
      (r) => r.id !== old.id && r.role === "implementer",
    );
    expect(replacement).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(state.task.stage).toBe("in_progress");
    expect(state.plan).toEqual(before.plan);
    expect(state.task.worktreePath).toBe(before.task.worktreePath);
    expect(state.desiredRun).toBeNull();
  } finally {
    await h.close();
  }
}, 30_000);
