// The snapshot the coordinator serves, and the patches that follow it (brief §8). Every row is
// parsed with the protocol's own schemas before it leaves, so a window can never be sent something
// it cannot validate. Nothing here is durable state: it is rebuilt from the store on demand.

import type { Sha, Task, TaskId, TaskState } from "@loom/core";
import { deriveAttention } from "@loom/core";
import type { Change, CollectionName, Entities } from "@loom/protocol";
import { changesKey, collections, keyOf } from "@loom/protocol";
import type { Store } from "@loom/store";
import type { Adapters } from "./adapters.js";
import type { CoordinatorConfig } from "./config.js";
import type { RecipeStore } from "./recipes.js";

export interface Row {
  collection: CollectionName;
  key: string;
  value: unknown;
}

const row = <N extends CollectionName>(collection: N, value: unknown): Row => {
  const parsed = collections[collection].value.parse(value) as Entities[N];
  return { collection, key: keyOf(collection, parsed), value: parsed };
};

/**
 * Attention is re-derived at snapshot time rather than read from the stored field, because a
 * stall or an unknown-status grace period can elapse between two passes (brief §8).
 */
function attentionFor(state: TaskState, now: string) {
  return deriveAttention({
    now: now as never,
    previous: state.task.attention,
    stage: state.task.stage,
    blocked: state.task.blocked,
    failed: state.task.failed,
    budgetMinutes: state.task.budgetMinutes,
    activeElapsedMs: state.activeElapsedMs,
    runs: state.runs,
    questions: state.questions,
    messages: state.messages,
    stallAfterMs: state.config.stallAfterMs,
    fixRoundStallAfterMs: state.config.fixRoundStallAfterMs,
    unknownGraceMs: state.config.unknownGraceMs,
  });
}

export function freshAttention(state: TaskState, now: string): Task {
  return { ...state.task, attention: attentionFor(state, now).attention };
}

export interface ViewDeps {
  store: Store;
  adapters: Adapters;
  recipes: RecipeStore;
  config: CoordinatorConfig;
  now(): string;
}

/** Where a human attaches to a run, and what the pane host says about its pane. */
export async function runTargetRow(
  deps: ViewDeps,
  state: TaskState,
  runId: string,
): Promise<Row | null> {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return null;
  let pane: unknown = null;
  let attach: unknown = null;
  if (run.pane) {
    const observation = await deps.adapters.paneHost
      .getPane(run.pane)
      .catch(() => null);
    const clients = await deps.adapters.paneHost
      .listClients(run.pane)
      .catch(() => []);
    if (observation)
      pane = {
        hostGeneration: run.pane.hostGeneration,
        sessionName: observation.ref.sessionName,
        windowId: run.pane.windowId,
        paneId: run.pane.paneId,
        dead: observation.dead,
        exitStatus: observation.exitCode,
        attachedClients: clients.length,
        size: clients[0]
          ? { cols: clients[0].cols, rows: clients[0].rows }
          : null,
        observedAt: deps.now(),
      };
    try {
      attach = {
        kind: "pane_host",
        argv: deps.adapters.paneHost.attachArgs(observation?.ref ?? run.pane),
        cwd: run.worktreePath,
        env: {},
      };
    } catch {
      attach = null;
    }
  }
  return row("run_target", {
    runId: run.id,
    taskId: run.taskId,
    sessionId: run.sessionId,
    attach,
    pane,
  });
}

/** Every row one task contributes, except its changed files, which follow a diff subscription. */
export async function taskRows(
  deps: ViewDeps,
  taskId: TaskId,
): Promise<{ state: TaskState; rows: Row[] }> {
  const state = deps.store.loadTaskState(taskId);
  const now = deps.now();
  const derived = attentionFor(state, now);
  const notes = deps.store.mainMessages.notes(taskId);
  const rows: Row[] = [
    row("task", { ...state.task, attention: derived.attention }),
    row("inbox", {
      taskId,
      linkedPrNumbers: deps.store.linkedPullRequests(state.task.repoId, taskId),
      forHuman: null,
      reasonRuns: Object.fromEntries(
        Object.entries(derived.reasonRunIds).map(([reason, ids]) => [
          reason,
          ids.flatMap((id) => state.runs.filter((run) => run.id === id)),
        ]),
      ),
      reviewedHead: state.review?.lastReviewedHead ?? null,
      planVersion: state.plan?.version ?? null,
      ci: state.ciGate
        ? {
            headSha: state.ciGate.headSha,
            since: state.ciGate.since,
            conclusion: state.ciGate.ci?.conclusion ?? null,
            checks: state.ciGate.ci?.checks ?? [],
            observedAt: state.ciGate.ci?.observedAt ?? null,
          }
        : null,
    }),
  ];
  for (const note of notes) rows.push(row("note", note));
  if (state.worktree) rows.push(row("worktree", state.worktree));
  for (const run of state.runs) {
    rows.push(row("run", run));
    const target = await runTargetRow(deps, state, run.id);
    if (target) rows.push(target);
  }
  for (const message of state.messages)
    rows.push(row("message", { ...message, taskId }));
  for (const question of state.questions) rows.push(row("question", question));
  for (const finding of state.findings) rows.push(row("finding", finding));
  for (const approval of state.approvals) rows.push(row("approval", approval));
  if (state.plan)
    rows.push(
      row("plan", {
        taskId,
        version: state.plan.version,
        accepted: state.plan.accepted,
        plan: (({ version: _v, accepted: _a, ...plan }) => plan)(state.plan),
      }),
    );
  const results = state.artifactContents.test_results;
  if (Array.isArray(results) && results.length)
    rows.push(
      row("test_results", {
        taskId,
        results,
        updatedAt:
          state.artifacts.find((a) => a.kind === "test_results")?.createdAt ??
          now,
      }),
    );
  for (const transition of deps.store.transitions(taskId))
    rows.push(row("transition", transition));
  // Comment threads and the review shell's state are the Workbench's, in Phase 4; nothing here
  // owns them yet, so the collections stay empty rather than being faked.
  return { state, rows };
}

/** The changed files for one task and one review range, from Git metadata (spike 04). */
export async function changesRow(
  deps: ViewDeps,
  taskId: TaskId,
  mode: "whole_branch" | "since_last_review",
): Promise<Row | null> {
  const state = deps.store.loadTaskState(taskId);
  const worktree = state.worktree;
  if (!worktree) return null;
  const observation = await deps.adapters.git
    .readWorktree(worktree.path, worktree.baseBranch)
    .catch(() => null);
  const headSha = observation?.headSha ?? null;
  if (!headSha) return null;
  const lastReviewedHead = state.review?.lastReviewedHead ?? null;
  if (mode === "since_last_review" && !lastReviewedHead) return null;
  const baseSha: Sha =
    mode === "since_last_review" ? (lastReviewedHead as Sha) : worktree.baseSha;
  const changes = await deps.adapters.git
    .changedFiles({ repoRoot: worktree.path, fromSha: baseSha, toSha: headSha })
    .catch(() => null);
  if (!changes) return null;
  const files = changes.map((change) => {
    const path = change.newPath ?? change.oldPath ?? "";
    const added = change.binary
      ? null
      : change.hunks.reduce((sum, h) => sum + h.newLines, 0);
    const deleted = change.binary
      ? null
      : change.hunks.reduce((sum, h) => sum + h.oldLines, 0);
    return {
      // Stable while this is the same file, across heads and renames (Pierre's file key).
      id: change.newBlobOid ?? change.oldBlobOid ?? path,
      path,
      previousPath:
        change.status === "renamed" || change.status === "copied"
          ? change.oldPath
          : null,
      status: change.status,
      binary: change.binary,
      added,
      deleted,
      // Bumped whenever the content changes: Pierre ignores a file whose version didn't change.
      version: 1,
    };
  });
  return row("changes", {
    id: changesKey(taskId, mode),
    taskId,
    range: { mode, baseSha, headSha, lastReviewedHead },
    files,
    patchKey: `${baseSha}..${headSha}`,
    computedAt: deps.now(),
  });
}

interface Published extends Row {
  encoded: string;
}

/**
 * Remembers what has been published, so a patch carries only what actually changed. Keyed by
 * collection and key; a row that disappears from a task's set becomes a delete carrying its task.
 */
export class PublishedRows {
  private readonly byOwner = new Map<string, Map<string, Published>>();

  /** Replaces one owner's rows (a task, or the repo list) and returns the changes that implies. */
  replace(
    owner: string,
    taskId: TaskId | null,
    rows: readonly Row[],
  ): Change[] {
    const previous = this.byOwner.get(owner) ?? new Map<string, Published>();
    const next = new Map<string, Published>();
    const changes: Change[] = [];
    for (const entry of rows) {
      // A key can hold any character a path can, so it is never packed into one flat string.
      const id = JSON.stringify([entry.collection, entry.key]);
      const encoded = JSON.stringify(entry.value);
      next.set(id, { ...entry, encoded });
      if (previous.get(id)?.encoded === encoded) continue;
      changes.push({
        op: "upsert",
        collection: entry.collection,
        value: entry.value,
      } as Change);
    }
    for (const [id, entry] of previous) {
      if (next.has(id)) continue;
      changes.push({
        op: "delete",
        collection: entry.collection,
        key: entry.key,
        taskId,
      } as Change);
    }
    this.byOwner.set(owner, next);
    return changes;
  }

  /** Drops an owner and reports the deletes that implies, so a client can forget its rows too. */
  forget(owner: string, taskId: TaskId | null): Change[] {
    const previous = this.byOwner.get(owner);
    this.byOwner.delete(owner);
    return [...(previous?.values() ?? [])].map(
      (entry) =>
        ({
          op: "delete",
          collection: entry.collection,
          key: entry.key,
          taskId,
        }) as Change,
    );
  }

  /** Every row currently published, for a snapshot that agrees with the patch stream. */
  rows(): Row[] {
    const all: Row[] = [];
    for (const owner of this.byOwner.values())
      for (const entry of owner.values())
        all.push({
          collection: entry.collection,
          key: entry.key,
          value: entry.value,
        });
    return all;
  }
}
