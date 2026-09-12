import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadScenarios } from "@loom/fake-agent";
import { expect, test, vi } from "vitest";
import { writeCodexHomeConfig } from "./launch.js";
import { createHarness, ScenarioDriver } from "./test-support.js";

test("all roles use configured Codex settings through store, recipes, turns, and recovery", async () => {
  let h = await createHarness({
    config: {
      providerOverrides: {
        planner: "codex",
        implementer: "codex",
        reviewer: "codex",
      },
      models: { codex: "gpt-5.6-sol", claude: "fake-claude" },
      codexReasoningEffort: "medium",
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
    for (const scenario of scenarios) scenario.agent.provider = "codex";
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
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      });
      expect(h.coordinator.recipes.get(run.id)).toMatchObject({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      });
    }
    expect(startThread).toHaveBeenCalled();
    for (const [request] of startThread.mock.calls)
      expect(request).toMatchObject({
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "medium" },
      });
    expect(startTurn).toHaveBeenCalled();
    for (const [request] of startTurn.mock.calls)
      expect(request).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" });

    const launch = h.store.outbox
      .list(created.task.id)
      .find((row) => row.action?.kind === "start_run")?.action;
    if (launch?.kind !== "start_run") throw new Error("Missing stored launch");
    expect(launch.reasoningEffort).toBe("medium");
    await writeCodexHomeConfig(h.dataRoot, launch, {
      type: "http",
      url: "http://127.0.0.1:1/mcp",
    });
    const config = await readFile(
      join(h.dataRoot, "codex", created.task.id, "codex-home", "config.toml"),
      "utf8",
    );
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain('model_reasoning_effort = "medium"');
    h = await h.restart();
    for (const run of h.store.loadTaskState(created.task.id).runs)
      expect(run.reasoningEffort).toBe("medium");
  } finally {
    await h.close();
  }
}, 30_000);
