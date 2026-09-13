// The fixture store, converted to a `@loom/protocol` snapshot. The shell was built before the
// protocol existed, so this adapter is where the two meet: `protocol.test.ts` parses the result
// with the real schemas, which is what keeps the fixtures and the contract from drifting.
//
// It also shows what the protocol adds over `@loom/core`'s entities: a task key on messages and
// test results, comment threads, review-shell state, the changed-files model and the review range.

import type { RunId, TaskId, WorktreePath } from "@loom/core";
import type {
  ChangedFile,
  CommentThread,
  ReviewState,
  RunTarget,
  SnapshotBody,
  SnapshotMeta,
  TaskChanges,
  TaskMessage,
  TaskPlan,
  TaskTestResults,
} from "@loom/protocol";
import { changesKey } from "@loom/protocol";
import type { Comment, Snapshot } from "./index.js";
import type { PatchFileMeta } from "./patch.js";

/** A canonical worktree path: the join key only joins once `..` is resolved (principle 6). */
function canonical(path: WorktreePath): WorktreePath {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}` as WorktreePath;
}

/** Git's own facts, split the way the protocol wants them: status, then binary, then counts. */
function changedFile(file: PatchFileMeta, index: number): ChangedFile {
  const binary = file.status === "binary";
  return {
    id: `file-${index}`,
    path: file.path,
    previousPath: file.previousPath,
    // The shell folds "binary" into the status; Git reports the two facts separately, and the
    // fixture's binary file is one the branch added.
    status: file.status === "binary" ? "added" : file.status,
    binary,
    added: binary ? null : file.added,
    deleted: binary ? null : file.deleted,
    version: 1,
  };
}

function threads(
  comments: Comment[],
  runOf: (id: TaskId) => RunId,
): CommentThread[] {
  const byFinding = new Map<string, Comment[]>();
  for (const comment of comments) {
    const list = byFinding.get(comment.findingId) ?? [];
    list.push(comment);
    byFinding.set(comment.findingId, list);
  }
  const out: CommentThread[] = [];
  for (const [findingId, list] of byFinding) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0] as Comment;
    const last = sorted[sorted.length - 1] as Comment;
    // Fixture finding IDs are `<taskId>-f<n>`.
    const taskId = findingId.slice(0, findingId.lastIndexOf("-f")) as TaskId;
    out.push({
      id: `${findingId}-thread`,
      taskId,
      findingId: findingId as CommentThread["findingId"],
      comments: sorted.map((comment) => ({
        id: comment.id,
        author:
          comment.author === "you"
            ? { kind: "human", name: "you" }
            : { kind: "agent", runId: runOf(taskId) },
        body: comment.body,
        at: comment.at,
        editedAt: null,
        externalId: null,
      })),
      resolvedAt: null,
      createdAt: first.at,
      updatedAt: last.at,
    });
  }
  return out;
}

export function toSnapshot(fixture: Snapshot): {
  meta: SnapshotMeta;
  body: SnapshotBody;
} {
  const implementer = (taskId: TaskId) => `${taskId}/implementer/0` as RunId;
  /** The join the shell had to do by parsing a run ID (PR #18, gap 7). */
  const taskOfRun = new Map<string, TaskId>(
    fixture.runs.map((run) => [run.id, run.taskId]),
  );
  const taskIds = new Set<string>(fixture.tasks.map((task) => task.id));
  const taskOf = (runId: RunId): TaskId => {
    const known = taskOfRun.get(runId);
    if (known) return known;
    // The fixtures give a backlog task an initial message for a run they never created, so fall
    // back to the run ID's own prefix. A coordinator always has the run, which is the point of
    // carrying the task ID on the row instead of parsing it here.
    const prefix = runId.slice(0, runId.indexOf("/"));
    if (!taskIds.has(prefix)) throw new Error(`no run ${runId}`);
    return prefix as TaskId;
  };

  const files = fixture.patch.files.map(changedFile);
  const fileOf = new Map(files.map((file) => [file.path, file]));
  const headOf = new Map(
    fixture.worktrees.map((worktree) => [worktree.taskId, worktree]),
  );

  const messages: TaskMessage[] = fixture.messages.map((message) => ({
    ...message,
    taskId: taskOf(message.runId),
  }));

  const plans: TaskPlan[] = Object.entries(fixture.plans).map(
    ([taskId, plan]) => ({
      taskId: taskId as TaskId,
      version: 1,
      accepted: true,
      plan,
    }),
  );

  const byTask = new Map<TaskId, TaskTestResults>();
  for (const result of fixture.testResults) {
    const taskId = taskOf(result.runId);
    const entry = byTask.get(taskId) ?? {
      taskId,
      results: [],
      updatedAt: result.ranAt,
    };
    entry.results.push(result);
    if (result.ranAt > entry.updatedAt) entry.updatedAt = result.ranAt;
    byTask.set(taskId, entry);
  }

  const runTargets: RunTarget[] = fixture.runs
    .filter((run) => run.pane !== null && run.endedAt === null)
    .map((run) => ({
      runId: run.id,
      taskId: run.taskId,
      sessionId: run.sessionId,
      attach: {
        // Whichever host runs the pane fills this in; the shell predates the tmux one.
        kind: "pane_host",
        argv: [
          "tmux",
          "-L",
          "loom-dev",
          "attach",
          "-t",
          `${run.pane?.sessionName ?? ""}:${run.pane?.windowId ?? ""}`,
        ],
        cwd: canonical(run.worktreePath),
        env: {},
      },
      pane: {
        hostGeneration: run.pane?.hostGeneration ?? "loom-dev#1",
        sessionName: run.pane?.sessionName ?? "",
        windowId: run.pane?.windowId ?? null,
        paneId: run.pane?.paneId ?? "%0",
        dead: false,
        exitStatus: null,
        attachedClients: 1,
        size: null,
        observedAt: fixture.now,
      },
    }));

  const changes: TaskChanges[] = [];
  const reviewStates: ReviewState[] = [];
  for (const [taskId, viewed] of Object.entries(fixture.viewedFiles)) {
    const id = taskId as TaskId;
    const worktree = headOf.get(id);
    const headSha = worktree?.git?.headSha;
    if (!worktree || !headSha) continue;
    changes.push({
      id: changesKey(id, "whole_branch"),
      taskId: id,
      range: {
        mode: "whole_branch",
        baseSha: worktree.baseSha,
        headSha,
        lastReviewedHead: null,
      },
      files,
      patchKey: fixture.patch.key,
      computedAt: fixture.now,
    });
    reviewStates.push({
      taskId: id,
      headSha,
      mode: "whole_branch",
      viewedFiles: viewed.flatMap((path) => {
        const file = fileOf.get(path);
        return file
          ? [{ fileId: file.id, path: file.path, headSha, at: fixture.now }]
          : [];
      }),
      currentFile: null,
      drafts: [],
      updatedAt: fixture.now,
    });
  }

  return {
    meta: { seq: 1, now: fixture.now, epoch: "fixtures" },
    body: {
      pullRequests: fixture.pullRequests,
      pullRequestDetails: [],
      operators: [],
      notes: [],
      panes: [],
      paneInventory: [],
      leads: [],
      projects: [{ id: "project", repoId: fixture.repos[0]?.id ?? null }],
      inbox: [],
      repos: fixture.repos.map((repo) => ({
        ...repo,
        root: canonical(repo.root),
      })),
      tasks: fixture.tasks.map((task) => ({
        ...task,
        worktreePath: task.worktreePath ? canonical(task.worktreePath) : null,
      })),
      worktrees: fixture.worktrees.map((worktree) => ({
        ...worktree,
        path: canonical(worktree.path),
      })),
      runs: fixture.runs.map((run) => ({
        ...run,
        worktreePath: canonical(run.worktreePath),
      })),
      runTargets,
      messages,
      questions: fixture.questions,
      findings: fixture.findings,
      approvals: fixture.approvals,
      plans,
      testResults: [...byTask.values()],
      transitions: fixture.transitions,
      threads: threads(fixture.comments, implementer),
      reviewStates,
      changes,
    },
  };
}
