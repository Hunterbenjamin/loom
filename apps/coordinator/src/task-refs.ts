import { resolveTaskRef, type TaskId } from "@loom/core";
import type { Command, ProtocolError } from "@loom/protocol";
import type { Store } from "@loom/store";

type Result =
  | { ok: true; command: Command }
  | { ok: false; error: ProtocolError };

const taskKinds = new Set([
  "human",
  "open_task_terminal",
  "create_scratch",
  "fetch_diff",
  "save_review_state",
]);

export function resolveCommandTaskRefs(
  command: Command,
  store: Store,
  scopeRepoId?: string,
): Result {
  const tasks = store.tasks();
  const repos = store.repos();
  const resolve = (value: string, repoId?: string) =>
    resolveTaskRef(value, { tasks, repos, repoId: repoId ?? scopeRepoId });
  const failure = (
    result: Exclude<ReturnType<typeof resolve>, { ok: true }>,
  ): Result => ({
    ok: false,
    error: {
      code: result.code === "unknown" ? "unknown_task" : "invalid_input",
      message: result.message,
      details: [],
    },
  });

  if (taskKinds.has(command.kind) && "taskId" in command) {
    const result = resolve(command.taskId);
    if (!result.ok) return failure(result);
    return {
      ok: true,
      command: { ...command, taskId: result.task.id } as Command,
    };
  }
  if (command.kind === "create_task") {
    const blockedBy: TaskId[] = [];
    for (const reference of command.blockedBy) {
      const result = resolve(reference, command.repoId);
      if (!result.ok) return failure(result);
      blockedBy.push(result.task.id);
    }
    return { ok: true, command: { ...command, blockedBy } };
  }
  return { ok: true, command };
}
