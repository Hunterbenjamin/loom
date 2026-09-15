// Loom MCP tools: what agents call. `packages/mcp` owns the zod schemas; they must stay equal to
// these types (checked with a type-level test there). The caller's run comes from the per-run
// token in its MCP config, so no tool takes a task or run ID.

import type {
  FindingAnchor,
  FindingStatus,
  Handoff,
  MappingStatus,
  Plan,
  Role,
  Severity,
  Side,
  Stage,
  TestOutcome,
  TestResult,
} from "./entities.js";
import type {
  FindingId,
  QuestionId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "./ids.js";

export type McpToolName =
  | "get_task_context"
  | "submit_plan"
  | "report_progress"
  | "ask_human"
  | "submit_for_review"
  | "submit_review"
  | "resolve_finding";

export type McpErrorCode =
  /** The input failed the schema. */
  | "invalid_input"
  /** The token doesn't map to a live run. */
  | "unknown_run"
  /** The run isn't the task's current run for its role (superseded, ended, or canceled). */
  | "stale_run"
  /** The tool isn't allowed for this role in the task's current stage. */
  | "wrong_stage"
  /** A guard failed: dirty tree, head mismatch, unknown finding ID, and so on. */
  | "guard_failed";

export interface McpError {
  code: McpErrorCode;
  message: string;
  /** One line per failed guard, written for the agent to act on. */
  details: string[];
}

export type McpResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: McpError };

// ---------------------------------------------------------------- get_task_context

export interface GetTaskContextInput {
  /** Return the complete role view even when this session has read it before. */
  full?: boolean;
}

export interface FindingView {
  id: FindingId;
  round: number;
  source: string;
  severity: Severity;
  blocking: boolean;
  status: FindingStatus;
  title: string;
  body: string;
  location: {
    path: string | null;
    side: Side;
    startLine: number | null;
    endLine: number | null;
    mapping: MappingStatus;
  } | null;
  /** The anchored text as originally selected. */
  snippet: string | null;
}

export interface TaskContextTask {
  id: TaskId;
  title: string;
  description: string;
  summary: string | null;
  stage: Stage;
  reviewRound: number;
  reviewRoundCap: number;
}

export interface TaskContextRun {
  id: RunId;
  round: number;
  attempts: number;
}

export interface TaskContextWorktree {
  path: WorktreePath;
  branch: string;
  baseBranch: string;
  baseSha: Sha;
  headSha: Sha | null;
  /** The head this review round reviews, and the one the previous round reviewed. */
  roundHead?: Sha | null | undefined;
  lastReviewedHead?: Sha | null | undefined;
}

export interface GetTaskContextFullOutput {
  view: "full";
  task: TaskContextTask;
  role: Role;
  run: TaskContextRun;
  worktree: TaskContextWorktree;
  brief: string;
  plan: (Plan & { version: number }) | null;
  /** The full append-only decisions log. */
  decisions: string;
  /** Present only for a fresh implementer fix round; computed without transcript content. */
  fixRound?: { reason: string; diff: string; truncated: boolean };
  handoff: Handoff | null;
  /** Implementer: open, escalated, addressed and disputed. Reviewer: prior rounds and current external findings. */
  findings: FindingView[];
  testResults: TestResult[];
  answeredQuestions: { id: QuestionId; question: string; answer: string }[];
  /** Commands from the repo's WORKFLOW.md: setup, test, lint, dev server, teardown. */
  workflow: Record<string, string>;
}

export interface TaskContextMustAct {
  id: FindingId;
  title: string;
  status: FindingStatus;
}

/** The stable, small part repeated with every changes view. */
export interface TaskContextHeader {
  task: Pick<TaskContextTask, "stage" | "reviewRound">;
  run: TaskContextRun;
  worktree: Pick<
    TaskContextWorktree,
    "baseSha" | "headSha" | "roundHead" | "lastReviewedHead"
  >;
}

export interface GetTaskContextChangesOutput {
  view: "changes";
  header: TaskContextHeader;
  mustAct: TaskContextMustAct[];
  /** Non-header task fields changed; the full task section is included. */
  task?: TaskContextTask;
  /** Non-header worktree fields changed; the full worktree section is included. */
  worktree?: TaskContextWorktree;
  brief?: string;
  plan?: (Plan & { version: number }) | null;
  /** The appended suffix, or the whole log when it was rewritten. */
  decisions?: string;
  fixRound?: { reason: string; diff: string; truncated: boolean };
  handoff?: Handoff | null;
  findings?: { changed: FindingView[]; noLongerVisible: FindingId[] };
  /** The appended suffix, or the whole list when it was rewritten. */
  testResults?: TestResult[];
  /** Questions newly answered since the previous read. */
  answeredQuestions?: { id: QuestionId; question: string; answer: string }[];
  workflow?: Record<string, string>;
}

export type GetTaskContextOutput =
  | GetTaskContextFullOutput
  | GetTaskContextChangesOutput;

// ---------------------------------------------------------------- submit_plan

export interface SubmitPlanInput {
  plan: Plan;
}

export interface SubmitPlanOutput {
  planVersion: number;
  next: "plan_approval" | "in_progress";
}

// ---------------------------------------------------------------- report_progress

export interface TestResultInput {
  command: string;
  outcome: TestOutcome;
  summary: string;
}

export interface ReportProgressInput {
  summary: string;
  /** Index into the plan's steps, when the work follows the plan. */
  stepIndex: number | null;
  /** Appended to decisions.md. */
  decisions: string[];
  testResults: TestResultInput[];
}

export interface ReportProgressOutput {
  recorded: true;
}

// ---------------------------------------------------------------- ask_human

export interface AskHumanInput {
  question: string;
  /** Empty for a free-text answer. */
  options: string[];
  /** Blocking: end the turn after asking. The task is flagged blocked until answered. */
  blocking: boolean;
}

export interface AskHumanOutput {
  questionId: QuestionId;
  /** The answer arrives later as a user message that quotes `questionId`. */
  delivery: "message";
}

// ---------------------------------------------------------------- submit_for_review

export interface SubmitForReviewInput {
  /** Must equal the worktree's HEAD, which must be clean and ahead of base. */
  headSha: Sha;
  summary: string;
  testResults: TestResultInput[];
  handoff: { summary: string; nextSteps: string[] };
}

export interface SubmitForReviewOutput {
  /** The review round this submission starts. */
  round: number;
}

// ---------------------------------------------------------------- submit_review

export interface FindingLocationInput {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
}

export interface FindingInput {
  severity: Severity;
  title: string;
  body: string;
  /** Open reviewer reports are non-blocking regardless of severity. */
  status?: "open" | "fixed" | "escalate";
  commitSha?: Sha;
  reason?: string;
  /** Lines in `reviewedSha`'s blob. Null for a task-level finding. */
  location: FindingLocationInput | null;
}

export interface FindingVerdictInput {
  findingId: FindingId;
  status: "resolved" | "reopened" | "fixed" | "escalate";
  note: string;
  commitSha?: Sha;
  reason?: string;
}

export interface SubmitReviewInput {
  /** Clean worktree HEAD, equal to or descended from the immutable round head. */
  reviewedSha: Sha;
  /** Complete ordered round-head..reviewedSha range attributed to this reviewer run. */
  reviewerCommits: Sha[];
  summary: string;
  findings: FindingInput[];
  /** One verdict per addressed/disputed finding and every remaining open blocker. */
  verdicts: FindingVerdictInput[];
  testResults: TestResultInput[];
}

export interface SubmitReviewOutput {
  round: number;
  openBlocking: number;
  next: "in_review" | "in_progress" | "awaiting_approval" | "blocked";
}

// ---------------------------------------------------------------- resolve_finding

export interface ResolveFindingInput {
  findingId: FindingId;
  resolution: "fixed" | "disputed";
  note: string;
  /** Required for `fixed`: the commit that fixes it. */
  commitSha: Sha | null;
}

export interface ResolveFindingOutput {
  status: FindingStatus;
}

// ---------------------------------------------------------------- registry

export interface McpTools {
  get_task_context: {
    input: GetTaskContextInput;
    output: GetTaskContextOutput;
  };
  submit_plan: { input: SubmitPlanInput; output: SubmitPlanOutput };
  report_progress: { input: ReportProgressInput; output: ReportProgressOutput };
  ask_human: { input: AskHumanInput; output: AskHumanOutput };
  submit_for_review: {
    input: SubmitForReviewInput;
    output: SubmitForReviewOutput;
  };
  submit_review: { input: SubmitReviewInput; output: SubmitReviewOutput };
  resolve_finding: { input: ResolveFindingInput; output: ResolveFindingOutput };
}

/**
 * A validated call, as persisted for the reconciler. The MCP layer does the I/O first: it assigns
 * IDs and builds each finding's full anchor from the reviewed blobs. `get_task_context` is
 * read-only and never becomes an input.
 */
export type McpCall =
  | { tool: "submit_plan"; input: SubmitPlanInput }
  | { tool: "report_progress"; input: ReportProgressInput }
  | { tool: "ask_human"; input: AskHumanInput; questionId: QuestionId }
  | { tool: "submit_for_review"; input: SubmitForReviewInput }
  | {
      tool: "submit_review";
      input: SubmitReviewInput;
      /** Parallel to `input.findings`. */
      drafts: { id: FindingId; anchor: FindingAnchor | null }[];
    }
  | { tool: "resolve_finding"; input: ResolveFindingInput };
