// A repository's WORKFLOW `setup` runs in every new worktree before an agent starts, so no agent
// spends a turn discovering an empty node_modules (and no reviewer repeats the discovery).

import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function start(files: Record<string, string>) {
  h = await createHarness({ files });
  const { task } = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Setup",
    description: "Worktree setup",
    size: "small",
  });
  h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const worktree = h.store.loadTaskState(task.id).worktree;
  if (!worktree) throw new Error("Missing worktree");
  return { task, worktree };
}

test("the workflow setup command runs once in the new worktree", async () => {
  const { worktree } = await start({
    "WORKFLOW.md": "## setup\n```sh\npnpm install --frozen-lockfile\n```\n",
  });
  expect(h.shellCalls).toEqual([
    { command: "pnpm install --frozen-lockfile", cwd: worktree.path },
  ]);
  expect(h.store.runs(worktree.taskId).length).toBeGreaterThan(0);
});

test("a repository without a setup command creates its worktree untouched", async () => {
  await start({ "WORKFLOW.md": "## test\n```sh\npnpm test\n```\n" });
  expect(h.shellCalls).toEqual([]);
});
