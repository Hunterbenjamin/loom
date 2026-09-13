import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreePath } from "@loom/core";
import { expect, test, vi } from "vitest";
import { openTaskTerminal } from "./task-terminal.js";
import { createHarness } from "./test-support.js";

test("task terminal selects the live agent, then reuses a worktree shell when that run ends", async () => {
  const h = await createHarness();
  try {
    const task = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Terminal routing",
      description: "fixture",
      size: "small",
    });
    h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    const state = h.store.loadTaskState(task.task.id);
    const agent = state.runs.find((run) => run.pane && !run.endedAt);
    if (!agent || !state.worktree)
      throw new Error("Missing interactive fixture");
    const create = vi.spyOn(h.paneHost, "createScratch");
    expect(await openTaskTerminal(state, h.repo, h.adapters)).toMatchObject({
      source: "agent",
      target: agent.pane,
      branch: state.worktree.branch,
    });
    expect(create).not.toHaveBeenCalled();
    // Historical panes are still physically present; they must not win over the shell fallback.
    state.runs = state.runs.map((run) => ({ ...run, endedAt: h.clock.now() }));
    const first = await openTaskTerminal(state, h.repo, h.adapters);
    const second = await openTaskTerminal(state, h.repo, h.adapters);
    expect(first).toEqual(second);
    expect(first.source).toBe("worktree");
    expect((await h.paneHost.getPane(first.target))?.startCwd).toBe(
      state.worktree.path,
    );
    expect(first.target).not.toEqual(agent.pane);
    await h.paneHost.closeTerminal(first.target);
    expect(
      (await openTaskTerminal(state, h.repo, h.adapters)).target,
    ).not.toEqual(first.target);
  } finally {
    await h.close();
  }
});

test("removed or missing task worktree opens project root and preserves its actual branch and dirty files", async () => {
  const h = await createHarness();
  try {
    await h.git("switch", "-c", "feat/keep-me");
    const dirty = join(h.repo.root, "unfinished.txt");
    await writeFile(dirty, "keep this work\n");
    const task = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Closed task",
      description: "fixture",
    });
    const state = h.store.loadTaskState(task.task.id);
    state.task.stage = "done";
    state.worktree = {
      path: join(h.repo.root, "deleted-worktree") as WorktreePath,
      taskId: state.task.id,
      repoId: h.repo.id,
      branch: "old-task",
      baseBranch: "main",
      baseSha: "a".repeat(40) as never,
      portSlot: null,
      paneWorkspaceId: "loom-old-task",
      createdAt: h.clock.now(),
      removedAt: h.clock.now(),
      git: null,
    };
    const first = await openTaskTerminal(state, h.repo, h.adapters);
    expect(first).toMatchObject({ source: "project", branch: "feat/keep-me" });
    expect((await h.paneHost.getPane(first.target))?.startCwd).toBe(
      h.repo.root,
    );
    state.worktree.removedAt = null;
    expect(await openTaskTerminal(state, h.repo, h.adapters)).toEqual(first);
    expect(await h.git("branch", "--show-current")).toBe("feat/keep-me");
    expect(await h.git("status", "--porcelain")).toContain("unfinished.txt");
    await h.git("checkout", "--detach");
    expect(
      (await openTaskTerminal(state, h.repo, h.adapters)).branch,
    ).toBeNull();
  } finally {
    await h.close();
  }
});

test("unavailable agent inventory does not create a competing shell", async () => {
  const h = await createHarness();
  try {
    const task = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Unavailable",
      description: "fixture",
      size: "small",
    });
    h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
    await h.coordinator.settle();
    vi.spyOn(h.paneHost, "getPane").mockRejectedValue(
      new Error("Host unavailable"),
    );
    const create = vi.spyOn(h.paneHost, "createScratch");
    await expect(
      openTaskTerminal(h.store.loadTaskState(task.task.id), h.repo, h.adapters),
    ).rejects.toThrow("Host unavailable");
    expect(create).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
