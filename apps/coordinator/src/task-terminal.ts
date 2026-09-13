import { createHash } from "node:crypto";
import type { PaneRef, Repo, TaskState, WorktreePath } from "@loom/core";
import type { Adapters } from "./adapters.js";
import { runEnvironment } from "./recipes.js";

/** A stable shell identity per task/location. Reopening a detail tab never multiplies shells. */
function shellKey(taskId: string, cwd: string) {
  const h = createHash("sha256")
    .update(JSON.stringify(["task-terminal", taskId, cwd]))
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function openTaskTerminal(
  state: TaskState,
  repo: Repo,
  adapters: Pick<Adapters, "git" | "paneHost">,
): Promise<{
  target: PaneRef;
  source: "agent" | "worktree" | "project";
  branch: string | null;
}> {
  const expectedRole =
    state.task.stage === "planning"
      ? "planner"
      : state.task.stage === "in_review"
        ? "reviewer"
        : "implementer";
  const runs = state.runs
    .filter(
      (r) =>
        !["done", "canceled"].includes(state.task.stage) &&
        !r.endedAt &&
        r.pane,
    )
    .sort(
      (a, b) =>
        Number(b.role === expectedRole) - Number(a.role === expectedRole) ||
        (b.launchedAt ?? "").localeCompare(a.launchedAt ?? "") ||
        b.id.localeCompare(a.id),
    );
  for (const run of runs) {
    if (!run.pane) continue;
    // Read the owner. A failed observation is not proof that an agent has stopped.
    const pane = await adapters.paneHost.getPane(run.pane);
    if (pane && !pane.dead && pane.startCwd === run.worktreePath)
      return {
        target: pane.ref,
        source: "agent",
        branch: await adapters.git.currentBranch(pane.startCwd),
      };
  }
  let cwd: WorktreePath | null = null;
  if (state.worktree && !state.worktree.removedAt) {
    try {
      cwd = await adapters.git.realpath(state.worktree.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const source = cwd ? "worktree" : "project";
  cwd ??= await adapters.git.realpath(repo.root);
  const workspaceId =
    source === "worktree" && state.worktree?.paneWorkspaceId
      ? state.worktree.paneWorkspaceId
      : (
          await adapters.paneHost.ensureWorkspace({
            taskId: (source === "project"
              ? `project-${repo.id}`
              : state.task.id) as typeof state.task.id,
            cwd,
            label: source === "project" ? repo.github : state.task.title,
          })
        ).workspaceId;
  const branch = await adapters.git.currentBranch(cwd);
  const target = await adapters.paneHost.createScratch({
    workspaceId,
    createWorkspace: true,
    key: shellKey(state.task.id, cwd),
    label: `${state.task.id} terminal`,
    cwd,
    executable: process.env.SHELL || "/bin/sh",
    args: ["-l"],
    env: runEnvironment(process.env, {}),
  });
  return { target, source, branch };
}
