// The MCP host (brief §5). `submit` persists the input, runs passes for its task until that input
// is consumed, and answers with its disposition. `context` is read-only and never enters the inbox.
// `resolveToken` consults current run state on every call. `buildAnchor` reads the reviewed blobs
// through the git adapter, never the working file.

import type {
  FindingAnchor,
  FindingLocationInput,
  FindingView,
  GetTaskContextOutput,
  InputDisposition,
  Repo,
  RunId,
  Sha,
  TaskId,
  TaskState,
} from "@loom/core";
import { McpGuardError, type McpHost, type McpInput } from "@loom/mcp";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import { sha256 } from "./derive.js";
import type { Loop } from "./loop.js";
import { taskBrief } from "./prompts.js";
import type { RecipeStore } from "./recipes.js";
import type { WorkflowReader } from "./workflow.js";

/** Lines of context hashed either side of the selection, so a move can still be recognized. */
export const CONTEXT_LINES = 3;

/** `lf-v1`: CRLF becomes LF before hashing. Recorded on the anchor so a reader knows. */
const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

export interface McpHostDeps {
  store: Store;
  adapters: Adapters;
  recipes: RecipeStore;
  loop: Loop;
  workflow: WorkflowReader;
  repo(taskId: TaskId): Repo;
  /** Bounded: an input is consumed within one pass per input queued ahead of it. */
  maxPasses?: number;
}

const findingViews = (
  state: TaskState,
  role: string,
  round: number,
): FindingView[] =>
  state.findings
    .filter((f) =>
      role === "reviewer"
        ? f.round < round
        : ["open", "addressed", "disputed"].includes(f.status),
    )
    .map((f) => ({
      id: f.id,
      round: f.round,
      source: f.source,
      severity: f.severity,
      blocking: f.blocking,
      status: f.status,
      title: f.title,
      body: f.body,
      location: f.location
        ? {
            path: f.location.path,
            side: f.location.side,
            startLine: f.location.startLine,
            endLine: f.location.endLine,
            mapping: f.location.status,
          }
        : null,
      snippet: f.anchor?.selectedText ?? null,
    }));

export function createMcpHost(deps: McpHostDeps): {
  host: McpHost;
  resolveToken(token: string): { runId: RunId; active: boolean } | null;
  buildAnchor(input: {
    runId: RunId;
    reviewedSha: Sha;
    location: FindingLocationInput;
  }): Promise<FindingAnchor>;
} {
  const taskOf = (runId: RunId): TaskId => {
    const recipe = deps.recipes.get(runId);
    if (!recipe) throw new Error(`No launch recipe for run ${runId}`);
    return recipe.taskId;
  };

  const host: McpHost = {
    async submit(input: McpInput): Promise<InputDisposition> {
      const taskId = taskOf(input.runId);
      const existing = deps.store.inputDisposition(taskId, input.id);
      if (existing) return existing;
      deps.store.enqueueInput(taskId, input);
      const limit = deps.maxPasses ?? 50;
      for (let pass = 0; pass < limit; pass++) {
        await deps.loop.pass(taskId);
        const disposition = deps.store.inputDisposition(taskId, input.id);
        if (disposition) return disposition;
      }
      throw new Error(`The task did not consume input ${input.id}`);
    },
    async context(runId: RunId): Promise<GetTaskContextOutput> {
      const taskId = taskOf(runId);
      const state = deps.store.loadTaskState(taskId);
      const run = state.runs.find((r) => r.id === runId);
      const worktree = state.worktree;
      if (!run || !worktree) throw new Error("The run has no task context yet");
      const repo = deps.repo(taskId);
      const git = await deps.adapters.git
        .readWorktree(worktree.path, worktree.baseBranch)
        .catch(() => null);
      return {
        task: {
          id: state.task.id,
          title: state.task.title,
          description: state.task.description,
          summary: state.task.summary,
          stage: state.task.stage,
          reviewRound: state.task.reviewRound,
          reviewRoundCap: state.task.reviewRoundCap,
        },
        role: run.role,
        run: { id: run.id, round: run.round, attempts: run.attempts },
        worktree: {
          path: worktree.path,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          baseSha: worktree.baseSha,
          headSha: git?.headSha ?? null,
        },
        brief:
          typeof state.artifactContents.brief === "string"
            ? state.artifactContents.brief
            : taskBrief(state.task),
        plan: state.plan
          ? (({ accepted: _accepted, ...plan }) => plan)(state.plan)
          : null,
        decisions:
          typeof state.artifactContents.decisions === "string"
            ? state.artifactContents.decisions
            : "",
        handoff: (state.artifactContents.handoff ??
          null) as GetTaskContextOutput["handoff"],
        findings: findingViews(state, run.role, run.round),
        testResults: (state.artifactContents.test_results ??
          []) as GetTaskContextOutput["testResults"],
        answeredQuestions: state.questions.flatMap((q) =>
          q.answer
            ? [{ id: q.id, question: q.question, answer: q.answer }]
            : [],
        ),
        // Design note 13.3: loaded and validated here, never a reconcile input.
        workflow: await deps.workflow.read(repo.root),
      };
    },
  };

  /**
   * Ended, superseded, canceled and completed runs are inactive. The mapping is retained either
   * way, so a stale token answers `stale_run` and an unknown one answers `unknown_run`.
   */
  const resolveToken = (
    token: string,
  ): { runId: RunId; active: boolean } | null => {
    const recipe = deps.recipes.resolve(token);
    if (!recipe) return null;
    let state: TaskState;
    try {
      state = deps.store.loadTaskState(recipe.taskId);
    } catch {
      return { runId: recipe.runId, active: false };
    }
    const run = state.runs.find((r) => r.id === recipe.runId);
    const current = state.runs
      .filter((r) => r.origin === "loom" && r.role === run?.role)
      .at(-1);
    return {
      runId: recipe.runId,
      active:
        !!run &&
        !run.endedAt &&
        run.attempts === recipe.attempt &&
        current?.id === run.id &&
        !["done", "canceled"].includes(state.task.stage),
    };
  };

  /**
   * The exact reviewed blob, read through git. A finding must land on a file this branch changed:
   * the git adapter can name a blob only through `changedFiles`, so an unchanged file has no
   * authoritative OID here and the reviewer is told to make the finding task-level instead.
   */
  const buildAnchor = async (input: {
    runId: RunId;
    reviewedSha: Sha;
    location: FindingLocationInput;
  }): Promise<FindingAnchor> => {
    const taskId = taskOf(input.runId);
    const state = deps.store.loadTaskState(taskId);
    const worktree = state.worktree;
    if (!worktree) throw new McpGuardError(["The task has no worktree"]);
    const { path, side, startLine, endLine } = input.location;
    if (startLine < 1 || endLine < startLine)
      throw new McpGuardError([`${path}: the line range is empty or inverted`]);
    const changes = await deps.adapters.git.changedFiles({
      repoRoot: worktree.path,
      fromSha: worktree.baseSha,
      toSha: input.reviewedSha,
    });
    const change = changes.find((c) =>
      side === "new" ? c.newPath === path : c.oldPath === path,
    );
    if (!change)
      throw new McpGuardError([
        `${path}: not changed between ${worktree.baseSha.slice(0, 12)} and ${input.reviewedSha.slice(0, 12)}; anchor the finding on a changed file, or leave the location null`,
      ]);
    if (change.binary)
      throw new McpGuardError([`${path}: binary files have no lines`]);
    const oid = side === "new" ? change.newBlobOid : change.oldBlobOid;
    if (!oid)
      throw new McpGuardError([
        `${path}: no ${side}-side blob in ${input.reviewedSha.slice(0, 12)}`,
      ]);
    const blob = await deps.adapters.git.readBlob(worktree.path, oid);
    if (blob === null)
      throw new McpGuardError([`${path}: the blob could not be read as text`]);
    const lines = normalize(blob).split("\n");
    if (endLine > lines.length)
      throw new McpGuardError([
        `${path}: lines ${startLine}-${endLine} are outside the file, which has ${lines.length}`,
      ]);
    const selectedText = lines.slice(startLine - 1, endLine).join("\n");
    const before = lines
      .slice(Math.max(0, startLine - 1 - CONTEXT_LINES), startLine - 1)
      .join("\n");
    const after = lines.slice(endLine, endLine + CONTEXT_LINES).join("\n");
    return {
      baseSha: worktree.baseSha,
      headSha: input.reviewedSha,
      oldPath: change.oldPath,
      newPath: change.newPath,
      oldBlobOid: change.oldBlobOid,
      newBlobOid: change.newBlobOid,
      side,
      startLine,
      endLine,
      startColumn: null,
      endColumn: null,
      selectedText,
      selectedTextHash: sha256(selectedText),
      contextBeforeHash: sha256(before),
      contextAfterHash: sha256(after),
      normalization: "lf-v1",
    };
  };

  return { host, resolveToken, buildAnchor };
}
