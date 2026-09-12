// What reconcile sees. Snapshots are fresh reads from each owner, never replayed events.
// Inputs (human commands, MCP calls, action results) are Loom-owned facts, each consumed once.

import type { ActionResult } from "./actions.js";
import type {
  CiState,
  FindingAnchor,
  Provider,
  ProviderRequestKind,
  Severity,
  Stage,
} from "./entities.js";
import type {
  ActionKey,
  FindingId,
  InputId,
  IsoTime,
  ProviderSessionId,
  QuestionId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "./ids.js";
import type { McpCall } from "./mcp.js";

/** A read from an owner. `ok: false` means unknown right now, not proof of anything. */
export type Reading<T> =
  | { ok: true; value: T; at: IsoTime }
  | { ok: false; reason: string; at: IsoTime };

// ---------------------------------------------------------------- git

export interface GitWorktreeObservation {
  /** Tracked changes and non-ignored untracked paths; ignored output is excluded. */
  dirtyPaths?: string[];
  /** Reachability checks supplied by the git boundary for resolve_finding inputs. */
  reachableCommits?: Sha[];
  path: WorktreePath;
  exists: boolean;
  branch: string | null;
  headSha: Sha | null;
  dirty: boolean;
  aheadOfBase: number;
  behindBase: number;
  /** From `git merge-tree --write-tree` against the current base. Null if not computed. */
  conflictsWithBase: boolean | null;
  /** The branch's head on the remote, from the last fetch. */
  remoteHeadSha: Sha | null;
}

// ---------------------------------------------------------------- GitHub

export interface GitHubReview {
  id: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  author: string;
  submittedAt: IsoTime;
}

export interface GitHubComment {
  id: string;
  reviewId: string | null;
  path: string | null;
  line: number | null;
  side: "old" | "new" | null;
  commitSha: Sha | null;
  body: string;
  author: string;
  createdAt: IsoTime;
}

export interface PullRequestObservation {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headSha: Sha;
  baseBranch: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  autoMergeEnabled: boolean;
  mergeCommitSha: Sha | null;
  mergedAt: IsoTime | null;
  ci: CiState;
  reviews: GitHubReview[];
  /** Human comments, excluding ones Loom or its agents wrote. */
  comments: GitHubComment[];
}

// ---------------------------------------------------------------- Codex (spike 01)

export interface CodexErrorObservation {
  message: string;
  willRetry: boolean;
  kind:
    | "rateLimitExceeded"
    | "usageLimitExceeded"
    | "serverOverloaded"
    | "other";
}

export interface CodexTurnObservation {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  error: CodexErrorObservation | null;
  /** Normalized-text hashes of user-message items in this turn. Confirms steered input. */
  userMessageHashes: string[];
}

export interface CodexRequestObservation {
  requestId: string;
  kind: ProviderRequestKind;
  isBlocking: boolean | null;
  summary: string;
  receivedAt: IsoTime;
}

export interface RateLimitObservation {
  usageAllowed: boolean;
  resetsAt: IsoTime | null;
}

/** A `thread/read` or `thread/resume` snapshot on the coordinator's app-server. */
export interface CodexThreadObservation {
  provider: "codex";
  threadId: ProviderSessionId;
  generation: number;
  status: "active" | "idle" | "systemError" | "notLoaded";
  activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[];
  /** Recent turns, oldest first. The last one may be in progress. */
  turns: CodexTurnObservation[];
  lastError: CodexErrorObservation | null;
  pendingRequests: CodexRequestObservation[];
  rateLimits: RateLimitObservation | null;
}

// ---------------------------------------------------------------- Claude (spike 02)

/** One entry of `claude agents --json`: the owner of live status. */
export interface ClaudeAgentsEntry {
  sessionId: ProviderSessionId;
  /** `busy`, `waiting` and `idle` were seen; anything else maps to `other`. */
  status: "busy" | "waiting" | "idle" | "other";
  rawStatus: string;
  kind: "interactive" | "background" | "other";
  pid: number | null;
  cwd: WorktreePath;
}

/** Hooks folded to what reconcile needs. Hooks add detail; they never decide status alone. */
export interface ClaudeHookSummary {
  lastEventAt: IsoTime | null;
  /** From the latest PreToolUse/PermissionRequest not yet followed by PostToolUse. */
  pendingDialog: {
    kind: "permission" | "input";
    tool: string;
    at: IsoTime;
  } | null;
  promptSubmits: { promptId: string; textHash: string; at: IsoTime }[];
  lastStop: {
    promptId: string;
    at: IsoTime;
    lastAssistantMessage: string | null;
  } | null;
  stopFailure: { error: string; at: IsoTime } | null;
  sessionStart: { source: string; at: IsoTime } | null;
  sessionEnd: { reason: string; at: IsoTime } | null;
}

export interface ClaudeSessionObservation {
  provider: "claude";
  sessionId: ProviderSessionId;
  /** Null: absent from `claude agents --json`. */
  agentsEntry: ClaudeAgentsEntry | null;
  hooks: ClaudeHookSummary;
  /** Headless runs the coordinator spawned: the process's own exit. */
  headless: {
    exited: boolean;
    exitCode: number | null;
    error: string | null;
  } | null;
}

// ---------------------------------------------------------------- Herdr (fallback only)

export interface HerdrAgentObservation {
  name: string;
  paneId: string;
  cwd: WorktreePath;
  /** Screen-derived. Used only when the provider channel is unavailable. */
  state: "working" | "blocked" | "idle" | "done" | "unknown";
  agentSessionId: string | null;
}

// ---------------------------------------------------------------- per run, per task

export interface RunObservation {
  /** False only after an authoritative provider resume check. */
  resumable?: boolean;
  /** Provider activity time, not the time of a no-change poll. */
  activityAt?: IsoTime;
  runId: RunId;
  provider: Reading<CodexThreadObservation | ClaudeSessionObservation | null>;
  /** Null for headless runs. `value: null` means Herdr has no such agent. */
  herdr: Reading<HerdrAgentObservation | null> | null;
}

/** A session in this task's worktree that Loom didn't launch. Observe-only. */
export interface ExternalSessionObservation {
  provider: Provider;
  sessionId: ProviderSessionId;
  cwd: WorktreePath;
  kind: "interactive" | "background" | "other";
  active: boolean;
}

/** Global run capacity. `version` is compare-and-set when a run is started. */
export interface CapacityObservation {
  version: number;
  active: Record<Provider, number>;
  caps: { total: number } & Record<Provider, number>;
  coolingDownUntil: Record<Provider, IsoTime | null>;
}

export interface DependencyObservation {
  taskId: TaskId;
  stage: Stage;
  merged: boolean;
}

// ---------------------------------------------------------------- inputs

export type HumanCommand =
  | { type: "move"; to: "backlog" | "todo" }
  | { type: "approve_plan"; planVersion: number }
  | { type: "reject_plan"; feedback: string }
  | { type: "approve"; headSha: Sha }
  | {
      type: "request_changes";
      findings: {
        id: FindingId;
        severity: Severity;
        title: string;
        body: string;
        anchor: FindingAnchor | null;
      }[];
    }
  | { type: "answer_question"; questionId: QuestionId; answer: string }
  | {
      type: "answer_provider_request";
      runId: RunId;
      requestId: string;
      generation: number | null;
      decision: "accept" | "decline" | "cancel";
      answers: Record<string, string[]> | null;
    }
  | { type: "send_message"; runId: RunId; text: string }
  | { type: "retry" }
  | { type: "grant_review_round" }
  | { type: "waive_finding"; findingId: FindingId; note: string }
  | { type: "cancel"; reason: string }
  | { type: "reopen" };

interface InputBase {
  id: InputId;
  receivedAt: IsoTime;
}

export type Input =
  | (InputBase & { type: "human"; command: HumanCommand })
  | (InputBase & { type: "mcp"; runId: RunId; call: McpCall })
  | (InputBase & {
      type: "action_result";
      key: ActionKey;
      result: ActionResult;
    });

// ---------------------------------------------------------------- the bundle

export interface Observations {
  now: IsoTime;
  /** Null: the task has no worktree yet. */
  git: Reading<GitWorktreeObservation> | null;
  /** Null: not read (no branch yet). `value: null`: no PR for the branch. */
  github: Reading<PullRequestObservation | null> | null;
  /** One per run of this task that hasn't ended. */
  runs: RunObservation[];
  externalSessions: ExternalSessionObservation[];
  capacity: CapacityObservation;
  dependencies: DependencyObservation[];
  /** Unconsumed inputs, in the order they were received. */
  inputs: Input[];
}
