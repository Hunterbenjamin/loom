// What reconcile sees. Snapshots are fresh reads from each owner, never replayed events.
// Inputs (human commands, MCP calls, action results) are Loom-owned facts, each consumed once.

import type { ActionResult } from "./actions.js";
import type {
  CiState,
  FindingAnchor,
  PaneRef,
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

/** Provider-independent, bounded conversation content. Providers remain the durable owner. */
export interface ConversationItem {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "thinking" | "tool" | "notice";
  text: string;
  clipped: boolean;
  tool: {
    name: string;
    input: string;
    status: "running" | "done" | "failed";
    output: string;
  } | null;
  at: IsoTime | null;
}

export interface ConversationRead {
  items: ConversationItem[];
  truncated: boolean;
}

// ---------------------------------------------------------------- git

export interface GitWorktreeObservation {
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
  /** Git adapter: complete tracked/non-ignored untracked dirty paths; [] means clean. */
  dirtyPaths: string[];
  /** Git boundary: queried commits and remote head proven reachable from this HEAD; [] means none. */
  reachableCommits: Sha[];
  /** Complete oldest-first range, only when the requested round head is an ancestor of HEAD. */
  reviewCommits?: { baseSha: Sha; headSha: Sha; commits: Sha[] } | null;
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
  command?: string;
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
  transcriptPath: string | null;
  /** From the latest PreToolUse/PermissionRequest not yet followed by PostToolUse. */
  pendingDialog: {
    command?: string;
    requestId?: string;
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
    completedTurns?: number;
    /** Latest native result, available even while streaming input remains open. */
    lastTurn?: { outcome: "completed" | "failed"; error: string | null };
    exited: boolean;
    exitCode: number | null;
    error: string | null;
  } | null;
}

// ---------------------------------------------------------------- pane host (tmux)

/**
 * Native pane facts only. The host never reports agent state: nothing here is screen-derived,
 * and provider identity is never inferred from a pane (spike 06 §4).
 */
export interface PaneObservation {
  /** Original workspace key retained by the host when its session is renamed. */
  workspaceId?: string;
  sessionId?: string | null;
  windowName?: string | null;
  windowIndex?: number;
  windowLayout?: string;
  title?: string | null;
  ref: PaneRef;
  /** The pane's current working directory; null once the pane is dead. */
  cwd: WorktreePath | null;
  /** The directory the pane was created in. Survives the process exiting; the task join key. */
  startCwd: WorktreePath;
  pid: number;
  /** The foreground command's name. A hint for humans, never an identity. */
  command: string;
  /** The agent CLI found in the pane's process tree, if any; a process fact, not a status. */
  agent?: "codex" | "claude" | null;
  /** The run id the host recorded on the pane at launch: Loom's pane, whatever its state. */
  owner?: string | null;
  dead: boolean;
  /** The exit status of a dead pane; null while it lives. */
  exitCode: number | null;
}

// ---------------------------------------------------------------- per run, per task

export interface RunObservation {
  runId: RunId;
  provider: Reading<CodexThreadObservation | ClaudeSessionObservation | null>;
  /** Null for headless runs. `value: null` means the pane host has no such pane. */
  pane: Reading<PaneObservation | null> | null;
  /** Provider adapter: true = resume verified, false = cannot resume, null = not yet known. */
  resumable: boolean | null;
  /** Provider adapter: latest known activity time; null = no activity evidence, not fetch time. */
  activityAt: IsoTime | null;
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
  | { type: "push_branch"; headSha: Sha }
  | { type: "open_pr"; headSha: Sha }
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
  | {
      type: "answer_pane_prompt";
      runId: RunId;
      choice: number | "enter" | "escape";
      expectedDialog?: {
        requestId: string;
        at: IsoTime;
        command?: string;
        sessionEpoch: number;
      };
      text?: string;
    }
  | {
      type: "send_message";
      runId: RunId;
      text: string;
      expectedRun?: { sessionEpoch: number; attempts: number };
    }
  | { type: "retry" }
  | { type: "restart_run"; runId: RunId }
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
  /** Validated commands read from the registered repository WORKFLOW.md. */
  workflowCommands?: Record<string, string>;
  now: IsoTime;
  /** Null: the task has no worktree yet. */
  git: Reading<GitWorktreeObservation> | null;
  /** Null: not read (no branch yet). `value: null`: no PR for the branch. */
  github: Reading<PullRequestObservation | null> | null;
  /** One per run of this task that hasn't ended. */
  runs: RunObservation[];
  /** External sessions successfully read. On read failure (transient errors), this is marked
   * `ok: false` to preserve unknown state; existing external runs should not be ended. */
  externalSessions: Reading<ExternalSessionObservation[]>;
  capacity: CapacityObservation;
  dependencies: DependencyObservation[];
  /** Unconsumed inputs, in the order they were received. */
  inputs: Input[];
}
