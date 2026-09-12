// Adapter interfaces: only what reconcile's observations and the executor's actions need.
// Every adapter validates external output with zod before returning these types.
// Subscriptions deliver hints: a reason to re-read, never a fact to act on.

import type { ActionOutputs } from "./actions.js";
import type { PaneRef } from "./entities.js";
import type {
  BlobOid,
  IsoTime,
  ProviderSessionId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "./ids.js";
import type {
  ClaudeAgentsEntry,
  ClaudeHookSummary,
  ClaudeSessionObservation,
  CodexThreadObservation,
  GitWorktreeObservation,
  PaneObservation,
  PullRequestObservation,
  RateLimitObservation,
} from "./observations.js";

export type Unsubscribe = () => void;

/** Something may have changed. The coordinator maps it to tasks and enqueues reconcile. */
export interface Hint {
  source: "codex" | "claude_hook" | "pane_host" | "github" | "git";
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
    /** Every fixing commit pending validation; omitted means no candidates requested. */
    reachableCandidates?: readonly Sha[],
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

// ---------------------------------------------------------------- pane host

/**
 * tmux, on a private server. The host owns terminal processes and nothing else: it never
 * reports agent state, never names a provider session, and never decides delivery.
 * Every method is idempotent on its key (`taskId`, `runId`, `PaneRef`).
 */
export interface PaneHost {
  /** Idempotent: the task's session, created if absent. Returns the session name. */
  ensureWorkspace(req: {
    taskId: TaskId;
    cwd: WorktreePath;
    label: string;
  }): Promise<ActionOutputs["open_workspace"]>;
  /**
   * Idempotent on `runId`: an existing live pane for the run is returned, never relaunched.
   * Runs `executable` directly — no shell, no typed prelude. `env` is the complete permitted
   * environment: the host removes every inherited name the allowlist omits (spike 06 §3).
   */
  ensurePane(req: {
    workspaceId: string;
    runId: RunId;
    cwd: WorktreePath;
    executable: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<PaneRef>;
  /** Human shell in an existing workspace, idempotent on key within a host generation. */
  createScratch(req: {
    workspaceId: string;
    key: string;
    cwd: WorktreePath;
    executable: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<PaneRef>;
  /** Null: no such pane in this host generation. A dead pane is still a pane. */
  getPane(ref: PaneRef): Promise<PaneObservation | null>;
  /** Every pane on the host, dead ones included. Join on `startCwd` (principle 6). */
  listPanes(): Promise<PaneObservation[]>;
  /**
   * Writes `text` and Enter into the pane. `"written"` is all it ever means: the paste is not
   * delivery, and the host does not know what the keystrokes did. In spike 06 a paste into a
   * pending permission dialog approved the command, so the coordinator must gate every call on
   * the provider's status and confirm delivery from the provider's own channel.
   */
  pasteText(ref: PaneRef, text: string): Promise<"written">;
  /** Escape or digit keys (0-9). Confirmation comes from the provider's status, never from the host. */
  sendKey(
    ref: PaneRef,
    key:
      | "Escape"
      | "Enter"
      | "0"
      | "1"
      | "2"
      | "3"
      | "4"
      | "5"
      | "6"
      | "7"
      | "8"
      | "9",
  ): Promise<void>;
  /** Full argv for a human terminal: explicit socket, session and pane. No takeover; clients share. */
  attachArgs(ref: PaneRef): string[];
  /** The clients currently attached to the pane's session, for the UI's attach indicator. */
  listClients(
    ref: PaneRef,
  ): Promise<{ id: string; cols: number; rows: number }[]>;
  /** Kills a pane Loom started, named by a ref from the current generation. Idempotent. */
  closePane(ref: PaneRef): Promise<void>;
  subscribe(onHint: OnHint): Unsubscribe;
}

// ---------------------------------------------------------------- Codex

export interface CodexAdapter {
  /** One adapter per task. Owns a child process with a private CODEX_HOME/socket. Idempotent. */
  startServer(): Promise<void>;
  /** Stops only this adapter's child process; never a shared daemon. Idempotent. */
  stopServer(): Promise<void>;
  /** Reconnect without stopping the server; caller resumes recorded threads afterwards. */
  reconnect(): Promise<void>;
  /** Fresh connection: read, then resume if unloaded. Only recorded Loom-owned IDs; unavailable is null. */
  checkResumable(threadId: ProviderSessionId): Promise<boolean | null>;
  /** Latest provider activity evidence, never the time of an unchanged poll. Persist in the coordinator. */
  activityAt(threadId: ProviderSessionId): IsoTime | null;
  /** Current app-server connection generation; null while disconnected. */
  generation(): number | null;
  startThread(req: {
    cwd: WorktreePath;
    model: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
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

/**
 * A run's MCP registration, as Claude's `--mcp-config` file and the Agent SDK both take it.
 * The run's token rides here, never in the `--settings` file: Claude Code 2.1.269 ignores
 * `mcpServers` in settings, and a token in argv would reach `ps` and the logs.
 */
export type McpServerEntry =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface ClaudeAdapter {
  /** `claude agents --json`: the owner of live status. */
  listSessions(): Promise<ClaudeAgentsEntry[]>;
  /** Hooks received for the session, folded. */
  hookSummary(sessionId: ProviderSessionId): Promise<ClaudeHookSummary>;
  /**
   * Writes the per-run settings file `interactiveArgs` and `startHeadless` are then given:
   * HTTP hooks pointing at this coordinator, the SessionStart command hook, and Loom's MCP
   * server. Never touches `~/.claude/settings.json`.
   */
  writeSettings(
    settingsPath: string,
    /** This run's registration. Omitted: the adapter's default, for tests and probes. */
    mcpServer?: McpServerEntry,
    /** Bash command prefixes to pre-allow without prompts (e.g., 'pnpm test', 'git commit'). */
    bashCommandPrefixes?: string[],
  ): Promise<void>;
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
    mcpOnly?: boolean;
    readOnly: boolean;
    prompt: string;
  }): Promise<void>;
  sendHeadless(req: {
    sessionId: ProviderSessionId;
    text: string;
  }): Promise<void>;
  stopHeadless(sessionId: ProviderSessionId): Promise<void>;
  interruptHeadless(sessionId: ProviderSessionId): Promise<void>;
  /** Closes the headless run and terminates its subprocess; unknown/closed sessions are a no-op. */
  closeHeadless(sessionId: ProviderSessionId): Promise<void>;
  headlessState(
    sessionId: ProviderSessionId,
  ): Promise<ClaudeSessionObservation["headless"]>;
  /**
   * `RunObservation.resumable`: does this session's transcript exist and parse? A
   * provider-confirmed answer, never inferred from a failed read or a vanished pane.
   */
  resumable(
    sessionId: ProviderSessionId,
    cwd: WorktreePath | null,
  ): Promise<boolean>;
  /** `RunObservation.activityAt`: latest hook receipt for the session; null means no evidence. */
  activityAt(sessionId: ProviderSessionId): Promise<IsoTime | null>;
  subscribe(onHint: OnHint): Unsubscribe;
}

/** Evidence from an adapter's own private resources; never inferred from logs. */
export interface AdapterDiagnostic {
  kind: "stale_process";
  resource: "codex_server" | "claude_headless";
  sessionId: string | null;
  message: string;
}
