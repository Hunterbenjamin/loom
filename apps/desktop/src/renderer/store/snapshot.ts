// Renderer-owned projection of coordinator state.
import type {
  Approval,
  Finding,
  IsoTime,
  Message,
  Plan,
  Question,
  Repo,
  Run,
  Task,
  TestResult,
  Transition,
  Worktree,
} from "@loom/core";
import type { PullRequestRow, TaskInbox } from "@loom/protocol";

/** A human comment thread on a finding. `@loom/core` has no reply type; see the PR notes. */
export interface Comment {
  id: string;
  findingId: string;
  author: string;
  body: string;
  at: IsoTime;
}

export interface Snapshot {
  now: IsoTime;
  repos: Repo[];
  tasks: Task[];
  inbox: TaskInbox[];
  pullRequests: PullRequestRow[];
  worktrees: Worktree[];
  runs: Run[];
  questions: Question[];
  messages: Message[];
  findings: Finding[];
  approvals: Approval[];
  plans: Record<string, Plan & { version?: number }>;
  testResults: TestResult[];
  transitions: Transition[];
  comments: Comment[];
  /** Review-shell state the coordinator will own; Pierre has none of it (spike 04). */
  viewedFiles: Record<string, string[]>;
  patch: SnapshotPatch;
}

export interface SnapshotPatch {
  /** A Git patch, exactly as `git diff` would print it. */
  text: string;
  /** Stable per-file metadata, taken from Git rather than from the patch text. */
  files: PatchFileMeta[];
  /** Content-derived cache key; also Pierre's revision key. */
  key: string;
  contents: Record<string, { old: string; new: string }>;
}

export interface PatchFileMeta {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  previousPath: string | null;
  added: number;
  deleted: number;
  language: string;
}
