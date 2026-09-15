import type { RepoId, Task, TaskId } from "@loom/core";

/** Explicit links win; otherwise a unique branch owner supplies the issue. */
export function pullRequestOwner(
  tasks: Task[],
  repoId: RepoId,
  head: string,
  linked?: TaskId | null,
) {
  if (
    linked &&
    tasks.some((task) => task.repoId === repoId && task.id === linked)
  )
    return linked;
  const matches = tasks.filter(
    (task) => task.repoId === repoId && task.branch === head,
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}
