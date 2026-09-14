import { randomUUID } from "node:crypto";
import type { InputId } from "@loom/core";
import { expect, test, vi } from "vitest";
import { recover } from "./recovery.js";
import { createHarness } from "./test-support.js";

test("startup recreates a lost workspace once, while lookup errors never authorize relaunch", async () => {
  const h = await createHarness();
  try {
    const task = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Recover planner",
      description: "",
    });
    h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    const run = h.store.loadTaskState(task.task.id).runs[0];
    if (!run?.pane) throw new Error("Missing recorded pane");
    const stored = h.store.loadTaskState(task.task.id);
    const storedRun = stored.runs.find((candidate) => candidate.id === run.id);
    if (!storedRun) throw new Error("Missing stored run");
    storedRun.inFlightTurnId = "turn-live";
    const expectedVersion = stored.task.version;
    stored.task.version++;
    expect(
      h.store.commit(
        task.task.id,
        { next: stored, actions: [], transitions: [], inputs: [] },
        expectedVersion,
      ).ok,
    ).toBe(true);
    const deps = {
      store: h.store,
      adapters: h.adapters,
      recipes: h.coordinator.recipes,
      launch: {
        adapters: h.adapters,
        config: h.config,
        recipes: h.coordinator.recipes,
        mcpEntry: () => ({
          type: "http" as const,
          url: "http://127.0.0.1:1/mcp",
        }),
        now: () => h.clock.now(),
      },
      repo: () => h.repo,
      now: () => h.clock.now(),
      nextInputId: () => randomUUID() as InputId,
      log: (line: string) => h.logs.push(line),
    };
    h.paneHost.restart();
    const lookup = vi
      .spyOn(h.paneHost, "getPane")
      .mockRejectedValueOnce(new Error("Host unavailable"));
    const before = h.paneHost.launches.length;
    const firstRecovery = await recover(deps, []);
    expect(firstRecovery.interrupted).toEqual([run.id]);
    expect(firstRecovery.relaunched).toEqual([]);
    expect(h.store.pendingInputs(task.task.id)).toContainEqual(
      expect.objectContaining({
        id: `restart_interrupted:${run.id}:turn-live`,
        type: "coordinator",
      }),
    );
    expect(h.paneHost.launches).toHaveLength(before);
    expect(h.logs.some((line) => line.includes("Host unavailable"))).toBe(true);
    lookup.mockRestore();
    const duplicateRecovery = await recover(deps, []);
    expect(duplicateRecovery.interrupted).toEqual([]);
    expect(duplicateRecovery.relaunched).toEqual([run.id]);
    const pane = h.store.loadTaskState(task.task.id).runs[0]?.pane;
    expect(pane?.hostGeneration).not.toBe(run.pane.hostGeneration);
    expect(await h.paneHost.getPane(pane as never)).toMatchObject({
      dead: false,
    });
    expect((await recover(deps, [])).relaunched).toEqual([]);
    expect(h.paneHost.launches).toHaveLength(before + 1);
  } finally {
    await h.close();
  }
}, 30_000);
