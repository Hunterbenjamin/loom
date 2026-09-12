import type { AttentionReason, IsoTime, Run, Task } from "@loom/core";
import type { TaskInbox } from "@loom/protocol";
import type { State, TabId } from "./store.js";

export const REASON_LABELS: Record<AttentionReason, string> = {
  plan_needs_approval: "Plan waiting for approval",
  needs_approval: "Merge waiting for approval",
  question: "Agent asked a question",
  provider_permission: "Agent waiting on a permission prompt",
  provider_input: "Agent waiting for input",
  blocked: "Blocked",
  failed: "Failed",
  run_vanished: "Agent session vanished",
  stalled: "No activity",
  status_unknown: "Status unknown",
  observability_failure: "Cannot observe run",
  over_budget: "Over budget",
};
export interface InboxRow {
  key: string;
  task: Task;
  reason: AttentionReason;
  since: IsoTime | null;
  runs: Run[];
  reviewedHead: TaskInbox["reviewedHead"];
}
export function reasonTab(reason: AttentionReason, run: Run | null): TabId {
  if (reason === "plan_needs_approval") return "plan";
  if (reason === "needs_approval") return "review";
  if (
    ["provider_permission", "provider_input", "question"].includes(reason) &&
    run?.mode === "interactive"
  )
    return "terminal";
  if (reason === "observability_failure") return "activity";
  return "activity";
}
let cache:
  | {
      tasks: Task[];
      inbox: TaskInbox[];
      repo: string;
      query: string;
      rows: InboxRow[];
    }
  | undefined;
export function inboxRows(state: State): InboxRow[] {
  const { tasks } = state.snapshot;
  const { inbox } = state;
  const { repo, query } = state.ui;
  if (
    cache &&
    cache.tasks === tasks &&
    cache.inbox === inbox &&
    cache.repo === repo &&
    cache.query === query
  )
    return cache.rows;
  const metadata = new Map(inbox.map((i) => [i.taskId, i]));
  const needle = query.trim().toLowerCase();
  const rows = tasks
    .flatMap((task) => {
      if (repo !== "all" && task.repoId !== repo) return [];
      if (needle && !`${task.id} ${task.title}`.toLowerCase().includes(needle))
        return [];
      const info = metadata.get(task.id);
      return task.attention.reasons.map((reason) => ({
        key: `${task.id}:${reason}`,
        task,
        reason,
        since: task.attention.reasonSince[reason] ?? task.attention.since,
        runs: info?.reasonRuns[reason] ?? [],
        reviewedHead: info?.reviewedHead ?? null,
      }));
    })
    .sort(
      (a, b) =>
        (a.since ?? "9999").localeCompare(b.since ?? "9999") ||
        a.key.localeCompare(b.key),
    );
  cache = { tasks, inbox, repo, query, rows };
  return rows;
}
export function attentionCount(state: State): number {
  return state.snapshot.tasks.reduce(
    (sum, task) => sum + task.attention.reasons.length,
    0,
  );
}
