import { stat } from "node:fs/promises";
import type { Sha } from "@loom/core";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function startSmall(title: string) {
  const { task } = h.coordinator.createTask({
    repoId: h.repo.id,
    title,
    description: "fixture",
    size: "small",
  });
  h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  return h.store.loadTaskState(task.id);
}

test("new worktrees use fetched origin/main while local main stays stale", async () => {
  h = await createHarness();
  const local = (await h.git("rev-parse", "main")) as Sha;
  const remote = await h.commitIn(
    h.repoRoot,
    { "remote-only.txt": "fresh\n" },
    "advance remote",
  );
  await h.git("push", "origin", "main");
  await h.git("reset", "--hard", local);

  const state = await startSmall("Fresh base");
  expect(state.worktree?.baseSha).toBe(remote);
  expect(await h.git("rev-parse", "refs/heads/main")).toBe(local);
  expect(
    await h.git("-C", state.worktree?.path ?? "", "rev-parse", "HEAD"),
  ).toBe(remote);
});

test("a failed fetch is retried and never creates from local main", async () => {
  h = await createHarness();
  const remote = await h.git("remote", "get-url", "origin");
  await h.git("remote", "set-url", "origin", `${remote}-missing`);
  const failed = await startSmall("Retry fetch");
  expect(failed.worktree).toBeNull();
  expect(
    failed.outbox.some(
      (row) =>
        row.kind === "create_worktree" &&
        row.status === "failed" &&
        row.retryAt,
    ),
  ).toBe(true);

  await h.git("remote", "set-url", "origin", remote);
  h.clock.advance(10_000);
  await h.coordinator.settle();
  expect(h.store.loadTaskState(failed.task.id).worktree).not.toBeNull();
});

test("canceled worktree removal waits for a live task terminal, then keeps the branch", async () => {
  h = await createHarness();
  const started = await startSmall("Cleanup canceled");
  if (!started.worktree?.paneWorkspaceId) throw new Error("Missing workspace");
  const terminal = await h.paneHost.createScratch({
    workspaceId: started.worktree.paneWorkspaceId,
    key: "human",
    cwd: started.worktree.path,
    executable: "/bin/sh",
    args: [],
    env: {},
  });
  h.coordinator.submitHuman(started.task.id, {
    type: "cancel",
    reason: "fixture",
  });
  await h.coordinator.settle();
  const refused = h.store.loadTaskState(started.task.id);
  expect(refused.task.stage).toBe("canceled");
  expect(refused.worktree?.removedAt).toBeNull();
  expect(
    refused.outbox.some(
      (row) => row.kind === "remove_worktree" && row.status === "failed",
    ),
  ).toBe(true);

  await h.paneHost.closeTerminal(terminal);
  h.clock.advance(10_000);
  await h.coordinator.settle();
  const removed = h.store.loadTaskState(started.task.id);
  expect(removed.worktree?.removedAt).not.toBeNull();
  await expect(stat(started.worktree.path)).rejects.toThrow();
  await expect(
    h.git("show-ref", "--verify", `refs/heads/${started.worktree.branch}`),
  ).resolves.toContain(started.worktree.branch);
});
