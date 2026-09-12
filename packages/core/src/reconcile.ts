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
  /** Pure caller-supplied UUIDv5 of `${runId}#${epoch}` in Loom's namespace. */
  deriveClaudeSessionId: (runId: RunId, epoch: number) => ProviderSessionId;
  /** Pure SHA-256; receives already normalized message text or canonical JSON. */
  sha256: (text: string) => string;
  worktreeRoot: string;
  baseBranch: string;
  models: Record<Provider, string>;
  retry: RetryPolicy;
  /** No provider activity for this long while working: `stalled` attention. Nothing is killed. */
  stallAfterMs: number;
  /** A run may be `unknown` this long before it gets `status_unknown` attention. */
  unknownGraceMs: number;
  /** A sent message with no provider confirmation after this long needs a decision. */
  deliveryTimeoutMs: number;
  githubPollMs: number;
}

export interface OutboxEntry {
  /** Retained so results and retries can recover the original intent. */
  action?: Action;
  retryAt?: IsoTime;
  /** Executor must wait for these intents to succeed before executing this row. */
  dependsOn?: ActionKey[];
  retriedBy?: ActionKey;
  retryBaseAttempt?: number;
  error?: ActionError;
  key: ActionKey;
  kind: ActionKind;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  attempts: number;
  createdAt: IsoTime;
  finishedAt: IsoTime | null;
}

/** Everything Loom owns about one task, loaded in one read transaction. */
export interface TaskState {
  /** Persist these alongside the original entity records. */
  consumedInputIds?: InputId[];
  artifactContents?: Partial<Record<Artifact["kind"], unknown>>;
  plan?: (Plan & { version: number; accepted: boolean }) | null;
  review?: {
    headSha: Sha;
    lastReviewedHead: Sha | null;
    previousBlocking: number | null;
    verdictIds: Finding["id"][];
  };
  desiredRun?: { role: Role; round: number; resume: boolean } | null;
  activeElapsedMs?: number;
  budgetObservedAt?: IsoTime;
  progress?: {
    runId: RunId;
    summary: string;
    stepIndex: number | null;
    at: IsoTime;
  };
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
  /** Executor/store must CAS this version when starts or ends reserve/release capacity. */
  capacityVersion?: number;
  next: TaskState;
  actions: Action[];
  /** New audit rows. */
  transitions: Transition[];
  /** Exactly one per input in `observations.inputs` that this pass consumed. */
  inputs: InputDisposition[];
}

/**
 * Pure and deterministic: no clock, randomness or I/O. The same arguments always give the same
 * result, and running it again on its own output with the same observations changes nothing.
 */
export type Reconcile = (
  state: TaskState,
  observations: Observations,
) => ReconcileResult;
