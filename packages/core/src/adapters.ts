// Adapter interfaces: only what reconcile's observations and the executor's actions need.
// Every adapter validates external output with zod before returning these types.
// Subscriptions deliver hints: a reason to re-read, never a fact to act on.

import type { ActionOutputs } from "./actions.js";
import type { HerdrRef, Provider } from "./entities.js";
import type { BlobOid, ProviderSessionId, Sha, WorktreePath } from "./ids.js";
import type {
  ClaudeAgentsEntry,
  ClaudeHookSummary,
  ClaudeSessionObservation,
  CodexThreadObservation,
  GitWorktreeObservation,
  HerdrAgentObservation,
  PullRequestObservation,
  RateLimitObservation,
} from "./observations.js";

export type Unsubscribe = () => void;

/** Something may have changed. The coordinator maps it to tasks and enqueues reconcile. */
export interface Hint {
  source: "codex" | "claude_hook" | "herdr" | "github" | "git";
  worktreePath: WorktreePath | null;
  sessionId: ProviderSessionId | null;
}

export type OnHint = (hint: Hint) => void;

/** A conditional GitHub read. `etag` goes back on the next request. */
export type Conditional<T> =
  | { notModified: true }
  | { notModified: false; value: T; etag: string | null };

// ---------------------------------------------------------------- Git

/** From NUL-delimited Git metadata, never from patch text (spike 04). */
export interface FileChange {
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type_changed";
  oldPath: string | null;
  newPath: string | null;
  oldBlobOid: BlobOid | null;
  newBlobOid: BlobOid | null;
  binary: boolean;
  hunks: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  }[];
}

export interface GitAdapter {
  realpath(path: string): Promise<WorktreePath>;
  readWorktree(
    path: WorktreePath,
    baseBranch: string,
  ): Promise<GitWorktreeObservation>;
  /** Idempotent: an existing worktree for the same branch is returned, not recreated. */
  createWorktree(req: {
    repoRoot: WorktreePath;
    path: string;
    branch: string;
    baseBranch: string;
  }): Promise<ActionOutputs["create_worktree"]>;
  /** Refuses unless the local branch head equals `expectedHeadSha`. Never forces. */
  push(req: {
    worktreePath: WorktreePath;
    branch: string;
    expectedHeadSha: Sha;
  }): Promise<ActionOutputs["push_branch"]>;
  /** Writes `<worktree>/.task/` and keeps `.task/` in `.git/info/exclude`. */
  writeTaskFiles(
    worktreePath: WorktreePath,
    files: { name: string; content: string }[],
  ): Promise<void>;
  changedFiles(req: {
    repoRoot: WorktreePath;
    fromSha: Sha;
    toSha: Sha;
  }): Promise<FileChange[]>;
  /** Null for a binary blob. */
  readBlob(repoRoot: WorktreePath, oid: BlobOid): Promise<string | null>;
}

// ---------------------------------------------------------------- GitHub

export interface GitHubAdapter {
  /** The PR whose head is `branch`, open or not. `value: null`: none. */
  findPullRequest(req: {
    repo: string;
    branch: string;
    etag: string | null;
  }): Promise<Conditional<PullRequestObservation | null>>;
  /** Idempotent: an existing PR for the branch is returned. */
  openPullRequest(req: {
    repo: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<ActionOutputs["open_pr"]>;
  /** Always squash, always `--match-head-commit`. */
  mergePullRequest(req: {
    repo: string;
    number: number;
    matchHeadSha: Sha;
    auto: boolean;
  }): Promise<ActionOutputs["merge_pr"]>;
  /** Idempotent: succeeds when auto-merge is already off. */
  disableAutoMerge(req: { repo: string; number: number }): Promise<void>;
}

// ---------------------------------------------------------------- Herdr

export type HerdrPromptResult =
  /** Text and Enter were written. Not delivery. */
  | "ok"
  /** `agent_blocked`: a dialog is waiting for the human. */
  | "blocked"
  | "stalled"
  | "not_found"
  /** The adapter refused text starting with `/` or `!`. Nothing was sent. */
  | "refused";

export interface HerdrAdapter {
  openWorkspace(req: {
    cwd: WorktreePath;
    label: string;
  }): Promise<ActionOutputs["open_workspace"]>;
  /** Starts with a scrubbed environment: no `CLAUDE_CODE_*` or `HERDR_*` variables. */
  startAgent(req: {
    name: string;
    kind: Provider;
    paneId: string;
    args: string[];
  }): Promise<HerdrRef>;
  getAgent(name: string): Promise<HerdrAgentObservation | null>;
  listAgents(): Promise<HerdrAgentObservation[]>;
  prompt(name: string, text: string): Promise<HerdrPromptResult>;
  /** `send-keys esc`. Confirmation comes from the provider's status, not from Herdr. */
  interrupt(name: string): Promise<void>;
  subscribe(onHint: OnHint): Unsubscribe;
}

// ---------------------------------------------------------------- Codex

export interface CodexAdapter {
  /** Current app-server connection generation; null while disconnected. */
  generation(): number | null;
  startThread(req: {
    cwd: WorktreePath;
    model: string;
    sandbox: "read-only" | "workspace-write";
    developerInstructions: string;
    config: Record<string, unknown>;
  }): Promise<{ threadId: ProviderSessionId; generation: number }>;
  startTurn(req: {
    threadId: ProviderSessionId;
    text: string;
  }): Promise<{ turnId: string }>;
  steerTurn(req: {
    threadId: ProviderSessionId;
    expectedTurnId: string;
    text: string;
  }): Promise<{ turnId: string }>;
  interruptTurn(req: {
    threadId: ProviderSessionId;
    turnId: string;
  }): Promise<void>;
  /** `thread/resume`: subscribe and return the hydrated snapshot. */
  resumeThread(threadId: ProviderSessionId): Promise<CodexThreadObservation>;
  readThread(threadId: ProviderSessionId): Promise<CodexThreadObservation>;
  unsubscribe(threadId: ProviderSessionId): Promise<void>;
  /** Rejects if `generation` isn't current: request IDs restart with the server. */
  answerRequest(req: {
    threadId: ProviderSessionId;
    generation: number;
    requestId: string;
    decision: "accept" | "decline" | "cancel";
    answers: Record<string, string[]> | null;
  }): Promise<void>;
  readRateLimits(): Promise<RateLimitObservation>;
  /** Pane command for an interactive run: `codex resume <thread> --remote unix://…`. */
  attachArgs(threadId: ProviderSessionId): string[];
  subscribe(onHint: OnHint): Unsubscribe;
}

// ---------------------------------------------------------------- Claude

export interface ClaudeAdapter {
  /** `claude agents --json`: the owner of live status. */
  listSessions(): Promise<ClaudeAgentsEntry[]>;
  /** Hooks received for the session, folded. */
  hookSummary(sessionId: ProviderSessionId): Promise<ClaudeHookSummary>;
  /**
   * Pane command for an interactive run: `--session-id` (or `--resume`), the per-run
   * `--settings` file with HTTP hooks, the SessionStart command hook and Loom's MCP server.
   */
  interactiveArgs(req: {
    sessionId: ProviderSessionId;
    resume: boolean;
    model: string;
    settingsPath: string;
  }): string[];
  /** Agent SDK. Loom chooses the session ID. */
  startHeadless(req: {
    sessionId: ProviderSessionId;
    resume: boolean;
    cwd: WorktreePath;
    model: string;
    settingsPath: string;
    readOnly: boolean;
    prompt: string;
  }): Promise<void>;
  sendHeadless(req: {
    sessionId: ProviderSessionId;
    text: string;
  }): Promise<void>;
  interruptHeadless(sessionId: ProviderSessionId): Promise<void>;
  headlessState(
    sessionId: ProviderSessionId,
  ): Promise<ClaudeSessionObservation["headless"]>;
  subscribe(onHint: OnHint): Unsubscribe;
}
