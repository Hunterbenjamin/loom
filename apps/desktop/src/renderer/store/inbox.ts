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
  idle_without_submission: "Agent stopped without submitting",
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
  planVersion: TaskInbox["planVersion"];
  forHuman: TaskInbox["forHuman"];
  section: InboxSection;
}
export type InboxSection = "for-you" | "decisions" | "questions" | "problems";
export const INBOX_SECTIONS: { id: InboxSection; label: string }[] = [
  { id: "for-you", label: "For you" },
  { id: "decisions", label: "Decisions" },
  { id: "questions", label: "Questions & prompts" },
  { id: "problems", label: "Problems" },
];
const sectionFor = (
  reason: AttentionReason,
  forHuman: TaskInbox["forHuman"],
): InboxSection =>
  forHuman
    ? "for-you"
    : ["plan_needs_approval", "needs_approval"].includes(reason)
      ? "decisions"
      : ["question", "provider_permission", "provider_input"].includes(reason)
        ? "questions"
        : "problems";
export function reasonTab(reason: AttentionReason, run: Run | null): TabId {
  if (
    reason === "plan_needs_approval" ||
    reason === "needs_approval" ||
    reason === "question"
  )
    return "overview";
  if (
    ["provider_permission", "provider_input", "question"].includes(reason) &&
    run?.mode === "interactive"
  )
    return "terminal";
  return "overview";
}
let cache:
  | {
      tasks: Task[];
      inbox: TaskInbox[];
      repo: string;
      rows: InboxRow[];
    }
  | undefined;
export function inboxRows(state: State): InboxRow[] {
  const { tasks } = state.snapshot;
  const { inbox } = state;
  const { repo } = state.ui;
  if (
    cache &&
    cache.tasks === tasks &&
    cache.inbox === inbox &&
    cache.repo === repo
  )
    return cache.rows;
  const metadata = new Map(inbox.map((i) => [i.taskId, i]));
  const rows = tasks
    .flatMap((task) => {
      if (task.repoId !== repo) return [];
      const info = metadata.get(task.id);
      return task.attention.reasons.map((reason) => ({
        key: `${task.id}:${reason}`,
        task,
        reason,
        since: task.attention.reasonSince[reason] ?? task.attention.since,
        runs: info?.reasonRuns[reason] ?? [],
        reviewedHead: info?.reviewedHead ?? null,
        planVersion: info?.planVersion ?? null,
        forHuman: info?.forHuman ?? null,
        section: sectionFor(reason, info?.forHuman ?? null),
      }));
    })
    .sort(
      (a, b) =>
        INBOX_SECTIONS.findIndex((section) => section.id === a.section) -
          INBOX_SECTIONS.findIndex((section) => section.id === b.section) ||
        (a.since ?? "9999").localeCompare(b.since ?? "9999") ||
        a.key.localeCompare(b.key),
    );
  cache = { tasks, inbox, repo, rows };
  return rows;
}
export function attentionCount(state: State): number {
  return state.snapshot.tasks
    .filter((task) => task.repoId === state.ui.repo)
    .reduce((sum, task) => sum + task.attention.reasons.length, 0);
}
