// Entities the coordinator stores. Field comments mark ownership:
//   (ref)   a reference to a fact another tool owns
//   (cache) a copy of another owner's fact, with the time it was read
//   (derived) recomputed by every reconcile; stored only so queries and snapshots are cheap
// Everything unmarked is authoritative in Loom.

import type {
  ApprovalId,
  ArtifactId,
  BlobOid,
  FindingId,
  InputId,
  IsoTime,
  MessageId,
  ProviderSessionId,
  QuestionId,
  RepoId,
  RunId,
  Sha,
  TaskId,
  TransitionId,
  WorktreePath,
} from "./ids.js";

import type { SubmitReviewInput } from "./mcp.js";

export type Provider = "codex" | "claude";
export type Role = "planner" | "implementer" | "reviewer";

// ---------------------------------------------------------------- Repo

export interface Repo {
  id: RepoId;
  /** Main checkout. (ref: local git) */
  root: WorktreePath;
  /** `owner/name`. (ref: GitHub) */
  github: string;
}

// ---------------------------------------------------------------- Task

export type Stage =
  | "backlog"
  | "todo"
  | "planning"
  | "plan_approval"
  | "in_progress"
  | "ci"
  | "in_review"
  | "awaiting_approval"
  | "merging"
  | "done"
  | "canceled";

export type BlockedReason =
  /** A `blockedBy` task isn't merged yet. */
  | "dependencies"
  /** A blocking `ask_human` question is unanswered. */
  | "question"
  /** Blocking findings remain after the last allowed review round. */
  | "review_round_cap"
  /** A finding was reopened, or the blocking count didn't drop between rounds. */
  | "review_not_converging"
  /** The run's provider is rate limited until `until`. */
  | "provider_cooling_down"
  /** The PR was closed without merging; the human decides whether to cancel. */
  | "pr_closed";

export interface BlockedFlag {
  reason: BlockedReason;
  since: IsoTime;
  detail: string;
  /** For `provider_cooling_down`: the provider's reset time. */
  until: IsoTime | null;
  questionId: QuestionId | null;
}

export type FailedReason =
  /** A run failed `maxAttempts` times. */
  | "retries_exhausted"
  /** The provider reported an error that retrying won't fix (for example, unsupported model). */
  | "non_retryable_error"
  /** An action (push, open PR, merge, create worktree) failed with a non-retryable error. */
  | "action_failed";

export interface FailedFlag {
  reason: FailedReason;
  since: IsoTime;
  detail: string;
  runId: RunId | null;
}

export interface ProviderRules {
  planner: Provider;
  implementer: Provider;
  reviewer: Provider;
}

export type AttentionReason =
  | "plan_needs_approval"
  | "needs_approval"
  | "question"
  | "provider_permission"
  | "provider_input"
  | "blocked"
  | "failed"
  /** An interactive run vanished; only a human relaunches it. */
  | "run_vanished"
  | "stalled"
  | "idle_without_submission"
  | "status_unknown"
  | "observability_failure"
  | "over_budget";

export interface Attention {
  /** Empty means the task doesn't need the human. Sorted. */
  reasons: AttentionReason[];
  /**
   * When each current reason first appeared, and has held since. Its keys are exactly `reasons`,
   * so a queue can sort by how long each thing has waited rather than by the set as a whole.
   */
  reasonSince: Partial<Record<AttentionReason, IsoTime>>;
  /** The earliest `reasonSince`: how long the task has needed the human. Null with no reasons. */
  since: IsoTime | null;
}

export interface Task {
  signature?: string | null;
  id: TaskId;
  repoId: RepoId;
  /** Per-repository sequence assigned by the store. Display only; never a join key. */
  number: number;
  /** Optional one-line human name, at most 32 characters, set at creation. */
  name: string | null;
  title: string;
  description: string;
  /**
   * Optional one-line summary of the task goal. Max 140 characters, no newlines.
   * Owned by Loom. Provided at creation time; not editable after.
   */
  summary: string | null;
  stage: Stage;
  stageEnteredAt: IsoTime;
  /** Compare-and-set counter. Every committed change adds 1. */
  version: number;
  blocked: BlockedFlag | null;
  failed: FailedFlag | null;
  requirePlanApproval: boolean;
  /** Captured at task creation. Automatic modes only remove the final human click. */
  mergePolicy?: import("./settings.js").MergePolicy;
  /** Role launch defaults captured when the task is created. */
  roleProfiles?: Partial<Record<Role, import("./settings.js").RoleProfile>>;
  /** Reviewer rounds started so far; 0 before the first review. */
  reviewRound: number;
  /** Default 3. Only a human raises it. */
  reviewRoundCap: number;
  providers: ProviderRules;
  blockedBy: TaskId[];
  /** Wall-clock budget; exceeding it adds `over_budget` attention, nothing else. */
  budgetMinutes: number | null;
  /** Task size: 'small' tasks skip planning and reduce reviewer scope. Defaults to 'normal'. */
  size: "small" | "normal";
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** Set once the worktree exists. (ref: local git; join key) */
  worktreePath: WorktreePath | null;
  /** Loom picks the name; git and GitHub own the branch. (ref) */
  branch: string | null;
  /** (ref: GitHub) */
  prNumber: number | null;
  /** (derived) */
  attention: Attention;
}

// ---------------------------------------------------------------- Worktree

export interface GitWorktreeCache {
  headSha: Sha | null;
  dirty: boolean;
  aheadOfBase: number;
  at: IsoTime;
}

export interface Worktree {
  /** Primary key. Canonical realpath. */
  path: WorktreePath;
  taskId: TaskId;
  repoId: RepoId;
  branch: string;
  baseBranch: string;
  /** Base commit when the worktree was created. */
  baseSha: Sha;
  /** `PORT = base + slot * 10`. Null until ports land (Phase 5). */
  portSlot: number | null;
  /** (ref: pane host) The tmux session hosting this task's panes. */
  paneWorkspaceId: string | null;
  createdAt: IsoTime;
  removedAt: IsoTime | null;
  /** (cache: local git) */
  git: GitWorktreeCache | null;
}

// ---------------------------------------------------------------- Run

export type RunMode = "headless" | "interactive";

export type RunStatus =
  /** Launch requested; no provider observation yet. */
  | "starting"
  | "working"
  /** Waiting on something outside the model; see `blockedOn`. */
  | "blocked"
  | "idle"
  | "failed"
  /** Terminal. See `endReason`. */
  | "ended"
  /** No authoritative live channel right now. Never read as idle or failed. */
  | "unknown";

export type RunBlockedOn = "permission" | "input" | "rate_limit";

export type TurnOutcome = "completed" | "interrupted" | "failed";

export type RunEndReason =
  | "submitted"
  | "superseded"
  | "canceled"
  /** A headless run's process died. Retried automatically. */
  | "crashed"
  /** An interactive run's session disappeared: a crash and a human closing the pane look the same. */
  | "vanished"
  | "failed"
  | "task_done";

export type ProviderRequestKind =
  | "command_approval"
  | "file_approval"
  | "permission"
  | "question";

/** A request the provider is waiting on. Cleared when the provider says it's resolved. */
export interface ProviderRequest {
  /** The provider's own ID. For Codex, only unique within `generation`. */
  id: string;
  generation: number | null;
  kind: ProviderRequestKind;
  /** Codex `isBlocking`, when the provider says. Don't infer it. */
  blocking: boolean | null;
  summary: string;
  receivedAt: IsoTime;
}

/**
 * A pane in the pane host. `hostGeneration` scopes `paneId`: tmux pane IDs restart at `%0`
 * after a server death, so a ref from an older generation names nothing (spike 06).
 */
export interface PaneRef {
  hostGeneration: string;
  sessionName: string;
  /** The pane's window. An attach client selects by window, so the ref has to carry it. */
  windowId: string;
  paneId: string;
}

/**
 * Provider-reported cumulative token counts. `input` includes `cachedInput`, and `output`
 * includes `reasoning`, matching the totals exposed by both supported providers.
 */
export interface TokenCounts {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export interface SessionTokenUsage {
  sessionId: ProviderSessionId;
  counts: TokenCounts;
  observedAt: IsoTime;
}

export interface Run {
  id: RunId;
  taskId: TaskId;
  role: Role;
  provider: Provider;
  mode: RunMode;
  /** `external`: a session started by hand in this worktree. Observe-only; Loom never controls it. */
  origin: "loom" | "external";
  worktreePath: WorktreePath;
  /** The review round this run belongs to (0 for the planner and the first implementer run). */
  round: number;
  /** Launches of this run so far, 1-based. A retry bumps it and keeps the row. */
  attempts: number;
  model: string;
  /** Captured at creation; retries and recovery retain the same reasoning setting. */
  reasoningEffort?: string;
  /** Captured semantic access policy; legacy rows use full. */
  access?: import("./settings.js").AccessPreset;
  /**
   * (ref: provider) Claude: UUIDv5 of `<runId>#<sessionEpoch>`, chosen before launch, so never null,
   * and reused by every attempt of that epoch.
   * Codex: the thread ID from `thread/start`, recorded before the first `turn/start`.
   */
  sessionId: ProviderSessionId | null;
  /** +1 only when the provider can no longer resume the session, deriving a fresh one. */
  sessionEpoch: number;
  /** (cache: provider) Latest cumulative usage for every provider session used by this run. */
  tokenUsage?: SessionTokenUsage[];
  /** Codex app-server connection generation; scopes request IDs. (ref) */
  codexGeneration: number | null;
  /** Interactive runs only. (ref: pane host) */
  pane: PaneRef | null;
  /** (derived from provider observations) */
  status: RunStatus;
  /** (derived) Set only when `status` is `blocked`. */
  blockedOn: RunBlockedOn | null;
  /** (cache: provider) Kept apart from `status`: an idle thread can have a failed last turn. */
  lastTurn: {
    id: string;
    outcome: TurnOutcome | null;
    error: string | null;
  } | null;
  /** (derived from fresh provider observations) Native turn currently in flight. */
  inFlightTurnId?: string | null;
  /** Coordinator-owned decision about a provider turn interrupted by restart. */
  restartInterruption?: {
    turnId: string;
    recordedAt: IsoTime;
    outcome: "continued" | "completed" | "not_needed" | null;
    decidedAt: IsoTime | null;
  } | null;
  /** (cache: provider) */
  pendingRequests: ProviderRequest[];
  /** Cached native Claude dialog, only while the provider reports waiting. Missing on legacy runs. */
  pendingDialog?: {
    requestId?: string;
    command?: string;
    kind: "permission" | "input";
    tool: string;
    at: IsoTime;
  } | null;
  /** Last provider observation of any kind. Drives stall detection. */
  lastActivityAt: IsoTime | null;
  /** Earliest time the next attempt may launch, after a failure. Headless runs only. */
  retryAt: IsoTime | null;
  launchedAt: IsoTime | null;
  endedAt: IsoTime | null;
  endReason: RunEndReason | null;
  seenAt?: IsoTime | null;
  unknownSince?: IsoTime | null;
  /** Start of the current idle interval; absent on legacy runs, cleared on activity/status change. */
  idleSince?: IsoTime | null;
  observedAttempt?: number;
  /** Attempts remain monotonic for action keys; human retry resets this budget offset. */
  retryBaseAttempt?: number;
}

export function sumTokenUsage(
  runs: Iterable<Pick<Run, "tokenUsage">>,
): TokenCounts {
  const total: TokenCounts = {
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
  };
  for (const run of runs)
    for (const usage of run.tokenUsage ?? []) {
      total.input += usage.counts.input;
      total.cachedInput += usage.counts.cachedInput;
      total.output += usage.counts.output;
      total.reasoning += usage.counts.reasoning;
    }
  return total;
}

// ---------------------------------------------------------------- Messages and questions

export type MessagePurpose =
  | "initial"
  | "fix_round"
  | "answer"
  | "plan_feedback"
  | "restart_continuation"
  | "human";

export type MessageStatus =
  /** Recorded; no send action has succeeded yet. */
  | "pending"
  /** The transport accepted it (`pasteText` wrote it, a `turn/start` response). Not proof of delivery. */
  | "sent"
  /** The provider confirmed it (Codex `turn/started`, Claude `UserPromptSubmit`). */
  | "delivered"
  | "failed";

export type DeliveryConfirmation =
  | { via: "codex_turn_started"; turnId: string }
  | { via: "codex_user_message_item"; turnId: string }
  | { via: "claude_user_prompt_submit"; promptId: string };

/** Executor-owned timing and identity of one successful transport attempt. */
export interface TransportAttempt {
  startedAt: IsoTime;
  completedAt: IsoTime;
  sessionId: ProviderSessionId;
  sessionEpoch: number;
  runAttempt: number;
}

export interface Message {
  id: MessageId;
  runId: RunId;
  purpose: MessagePurpose;
  text: string;
  /** Whether Loom may deliver during the current turn. Defaults to now for legacy rows. */
  when?: "now" | "after_turn";
  /** Coordinator-resolved local images for Codex native input. */
  images?: string[];
  /** sha256 of the text after the provider's normalization (tab → 4 spaces, CRLF → LF). */
  textHash: string;
  status: MessageStatus;
  /** Start of the current pending interval; absent on legacy records. */
  pendingSince?: IsoTime;
  attempts: number;
  /** Codex turn ID returned by `turn/start` or `turn/steer`. (ref) */
  transportRef: string | null;
  /** Transport completion time; legacy records may contain reconciliation time. */
  sentAt: IsoTime | null;
  /** Absent on records written before executor timing was persisted. */
  transportAttempt?: TransportAttempt;
  delivered: (DeliveryConfirmation & { at: IsoTime }) | null;
  via?: import("./actions.js").SendVia;
  expectedTurnId?: string | null;
  baselineTurnId?: string | null;
  deliveryAttention?: boolean;
  /** Current observable send blocker, suitable for a delivery-state tooltip. */
  deliveryReason?: string | null;
}

export interface Question {
  id: QuestionId;
  taskId: TaskId;
  runId: RunId;
  question: string;
  options: string[];
  blocking: boolean;
  askedAt: IsoTime;
  answer: string | null;
  answeredAt: IsoTime | null;
}

// ---------------------------------------------------------------- Artifacts

export type ArtifactKind =
  | "brief"
  | "plan"
  | "decisions"
  | "findings"
  | "test_results"
  | "handoff";

/** Metadata. The content is a file in the coordinator's data directory, mirrored to `.task/`. */
export interface Artifact {
  id: ArtifactId;
  taskId: TaskId;
  kind: ArtifactKind;
  /** Monotonic per (task, kind). `decisions` is append-only: each version extends the last. */
  version: number;
  /** Relative to the data directory. */
  path: string;
  sha256: string;
  createdBy: "human" | "coordinator" | { runId: RunId };
  createdAt: IsoTime;
}

export interface PlanStep {
  title: string;
  detail: string;
}

export interface Plan {
  goal: string;
  nonGoals: string[];
  steps: PlanStep[];
  /** Paths or globs the work will likely touch. Used for overlap warnings. */
  areas: string[];
  acceptanceCriteria: string[];
  testPlan: string[];
  risks: string[];
  openQuestions: string[];
  suggestedImplementer: Provider | null;
}

export type TestOutcome = "passed" | "failed" | "skipped" | "errored";

export interface TestResult {
  command: string;
  outcome: TestOutcome;
  summary: string;
  headSha: Sha;
  ranAt: IsoTime;
  runId: RunId;
}

export interface Handoff {
  reviewerSubmission?: {
    runId: RunId;
    round: number;
    input: SubmitReviewInput;
  };
  from: Role;
  to: Role;
  headSha: Sha | null;
  summary: string;
  nextSteps: string[];
}

// ---------------------------------------------------------------- Findings

export type FindingSource = "reviewer" | "human" | "github" | "ci" | "system";
export type Severity = "blocker" | "major" | "minor" | "nit";
/** Agent- and human-facing state. Kept apart from `MappingStatus`. */
export type FindingStatus =
  | "open"
  /** The implementer says a commit fixes it; the next reviewer verifies. */
  | "addressed"
  /** The implementer disagrees; the next reviewer or the human decides. */
  | "disputed"
  | "resolved"
  /** Reviewer committed an inline fix. */
  | "fixed"
  /** Reviewer requires an implementer fix round; resolution.note records why. */
  | "escalate"
  /** A human accepted it as is. */
  | "waived";
/** Where the anchor points on the current head. `outdated` never resolves a finding. */
export type MappingStatus = "exact" | "moved" | "ambiguous" | "outdated";
export type Side = "old" | "new";

/** Immutable once written (spike 04). Coordinates are in the exact blob, not a patch row. */
export interface FindingAnchor {
  baseSha: Sha;
  headSha: Sha;
  oldPath: string | null;
  newPath: string | null;
  oldBlobOid: BlobOid | null;
  newBlobOid: BlobOid | null;
  side: Side;
  startLine: number;
  endLine: number;
  startColumn: number | null;
  endColumn: number | null;
  selectedText: string;
  selectedTextHash: string;
  contextBeforeHash: string;
  contextAfterHash: string;
  /** How text was normalized before hashing. */
  normalization: "lf-v1";
}

/** Where the anchor maps on a later head. A new version per head. */
export interface FindingLocation {
  headSha: Sha;
  path: string | null;
  blobOid: BlobOid | null;
  side: Side;
  startLine: number | null;
  endLine: number | null;
  status: MappingStatus;
  version: number;
  mappedAt: IsoTime;
}

export interface FindingResolution {
  by: "implementer" | "reviewer" | "human" | "ci";
  note: string;
  commitSha: Sha | null;
  at: IsoTime;
}

export interface Finding {
  id: FindingId;
  taskId: TaskId;
  round: number;
  source: FindingSource;
  /** GitHub comment ID or check-run ID. (ref: GitHub) */
  externalId: string | null;
  createdByRunId: RunId | null;
  severity: Severity;
  /** Decided by code from severity and source when the finding is created. */
  blocking: boolean;
  title: string;
  body: string;
  status: FindingStatus;
  reopenCount: number;
  /** Null for findings about the task as a whole. */
  anchor: FindingAnchor | null;
  location: FindingLocation | null;
  resolution: FindingResolution | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

// ---------------------------------------------------------------- Approvals

export interface FindingsSnapshot {
  /** sha256 over the sorted (id, status, severity) triples below. */
  hash: string;
  findings: { id: FindingId; status: FindingStatus; severity: Severity }[];
  openBlocking: number;
}

export type CiConclusion = "success" | "pending" | "failure" | "none";

export interface CiCheck {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  url: string | null;
  /** GitHub adapter: stable check-run ID (stringified); never synthesize from name/head. */
  id: string;
}

/** (cache: GitHub) */
export interface CiState {
  headSha: Sha;
  conclusion: CiConclusion;
  checks: CiCheck[];
  observedAt: IsoTime;
}

export type ApprovalVoidReason =
  | "new_commit"
  | "ci_failed"
  | "findings_changed"
  | "plan_changed"
  | "stage_left";

export type Approval =
  | {
      id: ApprovalId;
      taskId: TaskId;
      kind: "plan";
      planVersion: number;
      createdAt: IsoTime;
      voidedAt: IsoTime | null;
      voidReason: ApprovalVoidReason | null;
    }
  | {
      id: ApprovalId;
      taskId: TaskId;
      kind: "merge";
      headSha: Sha;
      findings: FindingsSnapshot;
      ci: CiState;
      /** Who authorized the exact-head approval. Legacy rows are human. */
      approvedBy?: "human" | "policy";
      createdAt: IsoTime;
      voidedAt: IsoTime | null;
      voidReason: ApprovalVoidReason | null;
    };

// ---------------------------------------------------------------- Transitions (audit log)

export type TransitionTrigger =
  | { kind: "human"; command: string; inputId: InputId }
  | { kind: "mcp"; tool: string; runId: RunId; inputId: InputId }
  | { kind: "reconcile"; fact: string };

export interface FlagChange {
  blocked?: { from: BlockedReason | null; to: BlockedReason | null };
  failed?: { from: FailedReason | null; to: FailedReason | null };
}

/** Append-only. One row per committed stage or flag change. */
export interface Transition {
  id: TransitionId;
  taskId: TaskId;
  at: IsoTime;
  from: Stage;
  /** Equal to `from` for a flag-only change. */
  to: Stage;
  flags: FlagChange;
  trigger: TransitionTrigger;
  reason: string;
  /** Task version after this change. */
  taskVersion: number;
}

/** Authored decisions have their own persistence and never imply a stage transition. */
export interface TaskNote {
  id: string;
  taskId: string | null;
  author: "main" | "lead" | "human";
  at: string;
  eventId: string;
  row: string;
  outcome: string;
  body: string;
  forHuman: boolean;
  occurrence: string;
}

// ---------------------------------------------------------------- Utilities

/**
 * Get a one-line summary for display in lists. Returns the summary if present,
 * otherwise extracts and truncates the first sentence of the description to max 140 characters.
 * Handles edge cases: empty description, no punctuation, very long first sentence.
 */
export function summarizeTask(
  task: Pick<Task, "summary" | "description">,
): string {
  const summary = task.summary?.trim();
  if (summary) return summary;

  const firstLine = task.description.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "";

  const sentenceEnd = firstLine.search(/[.!?](?=\s|$)/);
  let firstSentence =
    sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;

  // Truncate to 140 chars if necessary (remove punctuation if truncating)
  if (firstSentence.length > 140) {
    firstSentence = `${firstSentence
      .slice(0, 137)
      .trim()
      .replace(/[.!?]+$/, "")}...`;
  }

  return firstSentence;
}
