// What reconcile asks the outside world to do. The executor runs each action after the
// reconcile commits, then records its result as an `action_result` input for a later reconcile.
// Actions are at-least-once: every executor must tolerate running the same key twice.

import type {
  ArtifactKind,
  FindingLocation,
  PaneRef,
  Provider,
  Role,
  RunMode,
  TransportAttempt,
} from "./entities.js";
import type {
  ActionKey,
  FindingId,
  IsoTime,
  MessageId,
  ProviderSessionId,
  RepoId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "./ids.js";

interface ActionBase {
  key: ActionKey;
  taskId: TaskId;
}

/** How a message reaches the provider. Chosen by provider and mode. */
export type SendVia =
  | "codex_turn_start"
  | "codex_turn_steer"
  /** Paste into the run's pane, then Enter. Never proof of delivery. */
  | "pane_paste"
  | "claude_sdk";

export type Action = ActionBase &
  (
    | {
        kind: "create_worktree";
        repoId: RepoId;
        /** Desired location. The result carries the realpath. */
        path: string;
        branch: string;
        baseBranch: string;
        requiredCommits?: Sha[];
      }
    | {
        kind: "remove_worktree";
        repoId: RepoId;
        worktreePath: WorktreePath;
        branch: string;
      }
    | {
        kind: "write_task_files";
        worktreePath: WorktreePath;
        artifacts: { kind: ArtifactKind; version: number }[];
      }
    | { kind: "open_workspace"; worktreePath: WorktreePath; label: string }
    | {
        kind: "start_run";
        runId: RunId;
        role: Role;
        provider: Provider;
        mode: RunMode;
        worktreePath: WorktreePath;
        model: string;
        reasoningEffort?: string;
        access?: import("./settings.js").AccessPreset;
        /** Which launch of the run this is; part of the action key. */
        attempt: number;
        /** The run's current session epoch; the Claude session ID derives from it. */
        sessionEpoch: number;
        /** Claude: the derived session ID. Codex: the thread to resume, else null (thread/start assigns it). */
        sessionId: ProviderSessionId | null;
        /**
         * True: reuse the session (Claude `--resume`, Codex `thread/resume`). False: start a fresh one.
         * Either way the ID is fixed for the epoch, so repeating this action adopts the same session.
         */
        resume: boolean;
      }
    | {
        kind: "send_message";
        runId: RunId;
        messageId: MessageId;
        via: SendVia;
        text: string;
        images: string[];
        /** Required for `codex_turn_steer`. */
        expectedTurnId: string | null;
      }
    | { kind: "interrupt_run"; runId: RunId; reason: string }
    | {
        kind: "answer_pane_prompt";
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
        kind: "answer_provider_request";
        runId: RunId;
        requestId: string;
        generation: number | null;
        decision: "accept" | "decline" | "cancel";
        answers: Record<string, string[]> | null;
      }
    /** Release a headless run's process or subscription. Never closes an interactive pane. */
    | {
        kind: "stop_run";
        runId: RunId;
        terminate?: boolean;
        /** Close the ended run's pane only; the session stays resumable through its ID. */
        retire?: boolean;
      }
    | {
        kind: "push_branch";
        worktreePath: WorktreePath;
        branch: string;
        /** Refuse to push anything else. */
        expectedHeadSha: Sha;
      }
    | {
        kind: "open_pr";
        rescueHeadSha?: Sha;
        repoId: RepoId;
        branch: string;
        baseBranch: string;
        title: string;
        body: string;
      }
    | {
        kind: "merge_pr";
        repoId: RepoId;
        prNumber: number;
        /** `gh pr merge --squash --match-head-commit`. */
        matchHeadSha: Sha;
        /** Add `--auto` because CI is still pending. */
        auto: boolean;
      }
    | {
        kind: "map_findings";
        worktreePath: WorktreePath;
        toHeadSha: Sha;
        findingIds: FindingId[];
      }
    /** Disarm auto-merge before anything else when its approval is voided. */
    | { kind: "disable_auto_merge"; repoId: RepoId; prNumber: number }
    /** Ask for a fresh read before the next reconcile. */
    | {
        kind: "refresh";
        owner: "git" | "github" | "codex_rate_limits" | "claude_agents";
      }
    /** Enqueue reconcile(taskId) at `at`. */
    | {
        kind: "schedule";
        at: IsoTime;
        why:
          | "retry"
          | "stall_check"
          | "cooldown_end"
          | "poll"
          | "delivery_timeout";
      }
    | {
        kind: "notify";
        level: "info" | "attention";
        title: string;
        body: string;
      }
  );

type Empty = Record<string, never>;

/** The success payload of each action kind. */
export interface ActionOutputs {
  create_worktree: { path: WorktreePath; headSha: Sha; baseSha: Sha };
  remove_worktree: { removed: boolean };
  write_task_files: Empty;
  /** The pane host's session for the task. Panes are created per run, not up front. */
  open_workspace: { workspaceId: string };
  start_run: {
    sessionId: ProviderSessionId;
    codexGeneration: number | null;
    pane: PaneRef | null;
  };
  /** Transport acceptance only. Delivery is confirmed later, by observation. */
  send_message: {
    transportRef: string | null;
    /** Optional only for action results persisted by older coordinators. */
    transportAttempt?: TransportAttempt;
  };
  /** The interrupt was sent. The run's status confirms it later. */
  interrupt_run: Empty;
  /** The pane prompt answer was sent. */
  answer_pane_prompt: Empty;
  answer_provider_request: Empty;
  stop_run: Empty;
  push_branch: { remoteHeadSha: Sha };
  /** An existing PR for the branch counts as success. */
  open_pr: { number: number; url: string };
  merge_pr: { state: "merged" | "auto_merge_enabled" };
  map_findings: {
    locations: { findingId: FindingId; location: FindingLocation }[];
  };
  disable_auto_merge: Empty;
  refresh: Empty;
  schedule: Empty;
  notify: Empty;
}

export type ActionKind = Action["kind"];

export interface ActionError {
  /**
   * `retryable`: transient; the reconciler may emit the action again after backoff.
   * `precondition`: the world differs from what the action assumed (head moved, PR closed);
   *   re-read and decide again.
   * `fatal`: don't retry; flag the task failed.
   */
  code: "retryable" | "precondition" | "fatal";
  message: string;
}

export type ActionResult = {
  [K in ActionKind]:
    | { kind: K; ok: true; output: ActionOutputs[K] }
    | { kind: K; ok: false; error: ActionError };
}[ActionKind];
