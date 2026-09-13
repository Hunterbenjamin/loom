// The pure reconciler contract. See engine.ts for the implementation and ../README.md for persistence requirements.

import type { Action, ActionError, ActionKind } from "./actions.js";
import type {
  Approval,
  Artifact,
  Finding,
  Message,
  Plan,
  Provider,
  Question,
  Role,
  Run,
  RunMode,
  Task,
  Transition,
  Worktree,
} from "./entities.js";
import type {
  ActionKey,
  InputId,
  IsoTime,
  ProviderSessionId,
  RunId,
  Sha,
} from "./ids.js";
import type { McpError, McpToolName, McpTools } from "./mcp.js";
import type { Observations } from "./observations.js";

export interface RetryPolicy {
  /** Delay before attempt n+1 is `min(baseMs * 2^(n-1), capMs)`. */
  baseMs: number;
  capMs: number;
  /** After this many failed attempts the task is flagged failed. */
  maxAttempts: number;
}

export interface ReconcileConfig {
  retry: RetryPolicy;
  /** Grace for working stalls and idle runs awaiting submission. Attention only; nothing is killed. */
  stallAfterMs: number;
  /** A run may be `unknown` this long before it gets `status_unknown` attention. */
  unknownGraceMs: number;
  /** A sent message with no provider confirmation after this long needs a decision. */
  deliveryTimeoutMs: number;
  githubPollMs: number;
  /** Pure caller-supplied UUIDv5 of `${runId}#${epoch}` in Loom's namespace. */
  deriveClaudeSessionId: (runId: RunId, epoch: number) => ProviderSessionId;
  /** Pure SHA-256; receives already normalized message text or serialized JSON. */
  sha256: (text: string) => string;
  worktreeRoot: string;
  baseBranch: string;
  models: Record<Provider, string>;
  /** Run mode for each role: interactive or headless. */
  runModes: Record<Role, RunMode>;
  /** Instance overrides apply when a role creates a new run; existing sessions retain their identity. */
  providerOverrides?: Partial<Record<Role, Provider>>;
  codexReasoningEffort?: string;
  /** Role-specific launch defaults. A run captures these and does not drift on retry/resume. */
  roleProfiles?: Partial<Record<Role, import("./settings.js").RoleProfile>>;
}

export interface OutboxEntry {
  key: ActionKey;
  kind: ActionKind;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  attempts: number;
  createdAt: IsoTime;
  finishedAt: IsoTime | null;
  /** Retained so results and retries can recover the original intent. */
  action?: Action;
  retryAt?: IsoTime;
  /** Executor must wait for these intents to succeed before executing this row. */
  dependsOn?: ActionKey[];
  retriedBy?: ActionKey;
  retryBaseAttempt?: number;
  error?: ActionError;
}

/** Everything Loom owns about one task, loaded in one read transaction. */
export interface TaskState {
  task: Task;
  worktree: Worktree | null;
  /** Runs that haven't ended, plus the latest ended run per role. */
  runs: Run[];
  /** Messages not yet delivered or failed. */
  messages: Message[];
  /** Unanswered questions. */
  questions: Question[];
  findings: Finding[];
  /** Approvals that aren't void. */
  approvals: Approval[];
  /** The latest version of each artifact kind. */
  artifacts: Artifact[];
  /** Actions that haven't finished, and ones that finished since the last reconcile. */
  outbox: OutboxEntry[];
  config: ReconcileConfig;

  /** Store supplies persisted receipts; [] only for a task with no consumed inputs. */
  consumedInputIds: InputId[];
  /** Store loads contents matching artifact versions; {} only before any artifact exists. */
  artifactContents: Partial<Record<Artifact["kind"], unknown>>;
  /** Store: null before the first submitted plan; accepted survives parking. */
  plan: (Plan & { version: number; accepted: boolean }) | null;
  /** Store: null before the first review; persists round head and verdict targets. */
  review: {
    headSha: Sha;
    lastReviewedHead: Sha | null;
    previousBlocking: number | null;
    verdictIds: Finding["id"][];
    /** Accepted review waiting for its push and fresh PR head/CI observation. */
    publicationPending?: boolean;
    reviewerCommits?: Sha[];
  } | null;
  /** Store: null when no launch/resume intent is waiting. */
  desiredRun: {
    role: Role;
    round: number;
    resume: boolean;
    /** Human retry: retire this attempt before rotating its session and launching again. */
    fresh?: boolean;
    replacement?: {
      runId: RunId;
      previousRunId: RunId;
      provider: Provider;
      model: string;
      reasoningEffort?: string;
      mode?: RunMode;
      access?: import("./settings.js").AccessPreset;
    };
  } | null;
  /** Store: accumulated active-stage milliseconds; initialize to 0. */
  activeElapsedMs: number;
  /** Store: last budget accounting time; initialize to task.createdAt. */
  budgetObservedAt: IsoTime;
  /** Store: latest accepted progress report, or null before any report. */
  progress: {
    runId: RunId;
    summary: string;
    stepIndex: number | null;
    at: IsoTime;
  } | null;
}

type SubmittingTool = Exclude<McpToolName, "get_task_context">;

export type McpReply = {
  [K in SubmittingTool]: { tool: K; value: McpTools[K]["output"] };
}[SubmittingTool];

/** What happened to each consumed input. The MCP layer turns this into the tool's response. */
export type InputDisposition =
  | { inputId: InputId; accepted: true; reply: McpReply | null }
  | { inputId: InputId; accepted: false; error: McpError };

export interface ReconcileResult {
  next: TaskState;
  actions: Action[];
  /** New audit rows. */
  transitions: Transition[];
  /** Exactly one per input in `observations.inputs` that this pass consumed. */
  inputs: InputDisposition[];
  /** Executor/store must CAS this version when starts or ends reserve/release capacity. */
  capacityVersion?: number;
}

/**
 * Pure and deterministic: no clock, randomness or I/O. The same arguments always give the same
 * result, and running it again on its own output with the same observations changes nothing.
 */
export type Reconcile = (
  state: TaskState,
  observations: Observations,
) => ReconcileResult;
