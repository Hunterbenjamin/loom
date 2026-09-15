import type { RunId, Sha } from "./ids.js";
import type {
  FindingView,
  GetTaskContextChangesOutput,
  GetTaskContextFullOutput,
  TaskContextMustAct,
} from "./mcp.js";
import type { TaskState } from "./reconcile.js";

export interface TaskContextProjection {
  state: TaskState;
  runId: RunId;
  headSha: Sha | null;
  brief: string;
  workflow: Record<string, string>;
}

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const findingViews = (
  state: TaskState,
  role: TaskState["runs"][number]["role"],
  round: number,
): FindingView[] =>
  state.findings
    .filter((finding) =>
      role === "reviewer"
        ? finding.round < round || finding.source !== "reviewer"
        : ["open", "escalate", "addressed", "disputed"].includes(
            finding.status,
          ),
    )
    .map((finding) => ({
      id: finding.id,
      round: finding.round,
      source: finding.source,
      severity: finding.severity,
      blocking: finding.blocking,
      status: finding.status,
      title: finding.title,
      body: finding.body,
      location: finding.location
        ? {
            path: finding.location.path,
            side: finding.location.side,
            startLine: finding.location.startLine,
            endLine: finding.location.endLine,
            mapping: finding.location.status,
          }
        : null,
      snippet: finding.anchor?.selectedText ?? null,
    }));

/** Build the complete context visible to one run. This is the sole owner of role filtering. */
export function taskContextFull({
  state,
  runId,
  headSha,
  brief,
  workflow,
}: TaskContextProjection): GetTaskContextFullOutput {
  const run = state.runs.find((candidate) => candidate.id === runId);
  const worktree = state.worktree;
  if (!run || !worktree) throw new Error("The run has no task context yet");
  return {
    view: "full",
    task: {
      id: state.task.id,
      title: state.task.title,
      description: state.task.description,
      summary: state.task.summary,
      stage: state.task.stage,
      reviewRound: state.task.reviewRound,
      reviewRoundCap: state.task.reviewRoundCap,
    },
    role: run.role,
    run: { id: run.id, round: run.round, attempts: run.attempts },
    worktree: {
      path: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseSha: worktree.baseSha,
      headSha,
      roundHead: state.review?.headSha ?? null,
      lastReviewedHead: state.review?.lastReviewedHead ?? null,
    },
    brief,
    plan: state.plan
      ? (({ accepted: _accepted, ...plan }) => plan)(state.plan)
      : null,
    decisions:
      typeof state.artifactContents.decisions === "string"
        ? state.artifactContents.decisions
        : "",
    handoff: (state.artifactContents.handoff ??
      null) as GetTaskContextFullOutput["handoff"],
    findings: findingViews(state, run.role, run.round),
    testResults: (state.artifactContents.test_results ??
      []) as GetTaskContextFullOutput["testResults"],
    answeredQuestions: state.questions.flatMap((question) =>
      question.answer
        ? [
            {
              id: question.id,
              question: question.question,
              answer: question.answer,
            },
          ]
        : [],
    ),
    workflow,
  };
}

const appended = <T>(previous: T[], current: T[]): T[] | null =>
  previous.length <= current.length &&
  previous.every((item, index) => equal(item, current[index]))
    ? current.slice(previous.length)
    : null;

const mustAct = (context: GetTaskContextFullOutput): TaskContextMustAct[] =>
  context.findings
    .filter((finding) =>
      context.role === "implementer"
        ? finding.blocking && ["open", "escalate"].includes(finding.status)
        : context.role === "reviewer" &&
          ["addressed", "disputed"].includes(finding.status),
    )
    .map(({ id, title, status }) => ({ id, title, status }));

/** Diff two consecutive full views for the same provider session. */
export function taskContextChanges(
  previous: GetTaskContextFullOutput,
  current: GetTaskContextFullOutput,
): GetTaskContextChangesOutput {
  const changes: GetTaskContextChangesOutput = {
    view: "changes",
    header: {
      task: {
        stage: current.task.stage,
        reviewRound: current.task.reviewRound,
      },
      run: current.run,
      worktree: {
        baseSha: current.worktree.baseSha,
        headSha: current.worktree.headSha,
        roundHead: current.worktree.roundHead,
        lastReviewedHead: current.worktree.lastReviewedHead,
      },
    },
    mustAct: mustAct(current),
  };

  const previousTaskDetails = {
    ...previous.task,
    stage: undefined,
    reviewRound: undefined,
  };
  const currentTaskDetails = {
    ...current.task,
    stage: undefined,
    reviewRound: undefined,
  };
  if (!equal(previousTaskDetails, currentTaskDetails))
    changes.task = current.task;

  const previousWorktreeDetails = {
    path: previous.worktree.path,
    branch: previous.worktree.branch,
    baseBranch: previous.worktree.baseBranch,
  };
  const currentWorktreeDetails = {
    path: current.worktree.path,
    branch: current.worktree.branch,
    baseBranch: current.worktree.baseBranch,
  };
  if (!equal(previousWorktreeDetails, currentWorktreeDetails))
    changes.worktree = current.worktree;

  for (const field of ["brief", "plan", "handoff", "workflow"] as const)
    if (!equal(previous[field], current[field]))
      Object.assign(changes, { [field]: current[field] });

  if (previous.decisions !== current.decisions)
    changes.decisions = current.decisions.startsWith(previous.decisions)
      ? current.decisions.slice(previous.decisions.length)
      : current.decisions;

  const testResults = appended(previous.testResults, current.testResults);
  if (testResults === null) changes.testResults = current.testResults;
  else if (testResults.length > 0) changes.testResults = testResults;

  const previousFindings = new Map(
    previous.findings.map((finding) => [finding.id, finding]),
  );
  const currentFindingIds = new Set(
    current.findings.map((finding) => finding.id),
  );
  const changed = current.findings.filter(
    (finding) => !equal(previousFindings.get(finding.id), finding),
  );
  const noLongerVisible = previous.findings
    .filter((finding) => !currentFindingIds.has(finding.id))
    .map((finding) => finding.id);
  if (changed.length > 0 || noLongerVisible.length > 0)
    changes.findings = { changed, noLongerVisible };

  const previousQuestionIds = new Set(
    previous.answeredQuestions.map((question) => question.id),
  );
  const answeredQuestions = current.answeredQuestions.filter(
    (question) => !previousQuestionIds.has(question.id),
  );
  if (answeredQuestions.length > 0)
    changes.answeredQuestions = answeredQuestions;

  return changes;
}
