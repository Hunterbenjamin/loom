import type { ClientState, CollectionName, PatchFrame } from "@loom/protocol";
import type { Snapshot } from "../fixtures/index.js";

export function emptySnapshot(): Snapshot {
  return {
    now: new Date().toISOString() as Snapshot["now"],
    repos: [],
    tasks: [],
    pullRequests: [],
    worktrees: [],
    runs: [],
    questions: [],
    messages: [],
    findings: [],
    approvals: [],
    plans: {},
    testResults: [],
    transitions: [],
    comments: [],
    viewedFiles: {},
    patch: { text: "", files: [], key: "empty", contents: {} },
  };
}

/** Preserve array identities for untouched collections so detail patches cannot repaint lists. */
export function projectSnapshot(
  previous: Snapshot,
  state: ClientState,
  patch?: PatchFrame,
): Snapshot {
  const changed = new Set<CollectionName>(
    patch?.changes.map((c) => c.collection),
  );
  const has = (name: CollectionName) => !patch || changed.has(name);
  const next = { ...previous, now: state.now };
  const c = state.collections;
  if (has("repo")) next.repos = [...c.repo.values()];
  if (has("pull_request")) next.pullRequests = [...c.pull_request.values()];
  if (has("task")) next.tasks = [...c.task.values()];
  if (has("worktree")) next.worktrees = [...c.worktree.values()];
  if (has("run")) next.runs = [...c.run.values()];
  if (has("question")) next.questions = [...c.question.values()];
  if (has("message")) next.messages = [...c.message.values()];
  if (has("finding")) next.findings = [...c.finding.values()];
  if (has("approval")) next.approvals = [...c.approval.values()];
  if (has("plan"))
    next.plans = Object.fromEntries(
      [...c.plan.values()].map((p) => [p.taskId, p.plan]),
    );
  if (has("test_results"))
    next.testResults = [...c.test_results.values()].flatMap((t) => t.results);
  if (has("transition")) next.transitions = [...c.transition.values()];
  return next;
}
