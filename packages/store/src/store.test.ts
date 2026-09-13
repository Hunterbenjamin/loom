import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputId, TaskId } from "@loom/core";
import { reconcile } from "@loom/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture as coreFixture } from "../../core/test/fixtures.js";
import {
  artifact,
  config,
  input,
  notify,
  now,
  repo,
  required,
  result,
  richState,
  task,
  taskId,
} from "../test/fixtures.js";
import { actionKind, actionSchema } from "./action-schemas.js";
import { openReadOnlyStore, openStore, type Store } from "./index.js";

let root: string;
const stores: Store[] = [];
async function open(instance = "dev") {
  const store = await openStore({ dataRoot: root, instance, config, now });
  stores.push(store);
  return store;
}
async function seeded() {
  const store = await open();
  store.putRepo(repo);
  store.createTask(task());
  return store;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-store-"));
});
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});
function db() {
  return new Database(join(root, "dev", "loom.sqlite"));
}
function snapshotSql() {
  const connection = db();
  try {
    return connection.serialize();
  } finally {
    connection.close();
  }
}

describe("task transactions", () => {
  it("round-trips tasks with and without summaries", async () => {
    const store = await open();
    store.putRepo(repo);
    const summarized = {
      ...task("with-summary" as TaskId),
      summary: "A concise persisted goal",
    };
    const unsummarized = task("without-summary" as TaskId);
    store.createTask(summarized);
    store.createTask(unsummarized);
    expect(store.tasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: summarized.id,
          summary: "A concise persisted goal",
        }),
        expect.objectContaining({ id: unsummarized.id, summary: null }),
      ]),
    );
    store.close();
    const restarted = await open();
    expect(restarted.loadTaskState(summarized.id).task.summary).toBe(
      "A concise persisted goal",
    );
    expect(restarted.loadTaskState(unsummarized.id).task.summary).toBeNull();
  });

  it("uses a real WAL database and isolates instances", async () => {
    const store = await seeded();
    const second = await open("test");
    expect(store.loadTaskState(taskId).budgetObservedAt).toBe(now);
    const connection = db();
    expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
    connection.close();
    expect(() => second.loadTaskState(taskId)).toThrow();
    await expect(
      openStore({ dataRoot: root, instance: "../dev", config }),
    ).rejects.toThrow();
  });
  it("persists native Claude dialog occurrences across reopen", async () => {
    const store = await seeded();
    const state = richState();
    const run = required(state.runs[0]);
    run.pendingDialog = {
      requestId: "claude-hook:session:42",
      command: "pnpm install",
      tool: "Bash",
      kind: "permission",
      at: now,
    };
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    store.close();
    const restarted = await open();
    expect(
      restarted.runs(taskId).find((r) => r.id === run.id)?.pendingDialog,
    ).toEqual(run.pendingDialog);
  });
  it("retains idle submission attention and its run interval across reopen", async () => {
    const store = await seeded();
    const state = richState();
    const run = required(state.runs[0]);
    run.idleSince = now;
    state.task.attention = {
      reasons: ["idle_without_submission"],
      reasonSince: { idle_without_submission: now },
      since: now,
    };
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    store.close();
    const restarted = await open();
    const restored = restarted.loadTaskState(taskId);
    expect(restored.runs.find((r) => r.id === run.id)?.idleSince).toBe(now);
    expect(restored.task.attention).toEqual(state.task.attention);
  });
  it("retains pending delivery age and attention across reopen", async () => {
    const store = await seeded();
    const state = richState();
    const message = required(state.messages[0]);
    message.status = "pending";
    message.pendingSince = now;
    message.deliveryAttention = true;
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    store.close();
    const restarted = await open();
    expect(restarted.loadTaskState(taskId).messages).toContainEqual(message);
  });
  it("round-trips every Phase 1b field through commit and reopen", async () => {
    const store = await seeded(),
      state = richState();
    expect(store.commit(taskId, result(state), 0)).toEqual({
      ok: true,
      version: 1,
      materializationErrors: [],
    });
    expect(store.loadTaskState(taskId)).toEqual(state);
    store.close();
    const restarted = await open();
    expect(restarted.loadTaskState(taskId)).toEqual(state);
    expect(
      JSON.parse(
        readFileSync(
          join(restarted.dataDirectory, required(state.artifacts[0]).path),
          "utf8",
        ),
      ),
    ).toEqual(state.plan);
    expect(restarted.capacityCounts()).toEqual({
      version: 0,
      active: { codex: 1, claude: 0 },
    });
    expect(restarted.tasksByStage("in_progress").map((t) => t.id)).toEqual([
      taskId,
    ]);
    expect(restarted.tasksNeedingAttention().map((t) => t.id)).toEqual([
      taskId,
    ]);
  });
  it("a stale version writes no SQL, receipts, transitions, outbox or artifact files", async () => {
    const store = await seeded(),
      state = richState();
    store.commit(taskId, result(state), 0);
    const before = snapshotSql();
    const loser = richState();
    artifact(loser, "brief", "must not write");
    const action = notify(loser);
    const stale = { ...result(loser), actions: [action] };
    expect(store.commit(taskId, stale, 0)).toMatchObject({
      ok: false,
      conflict: "task_version",
    });
    expect(snapshotSql()).toEqual(before);
    expect(() =>
      readFileSync(
        join(store.dataDirectory, required(loser.artifacts.at(-1)).path),
      ),
    ).toThrow();
  });
  it("rolls back the task CAS when global capacity changed in another connection", async () => {
    const store = await seeded(),
      second = await open();
    store.createTask(task("t2" as TaskId));
    const a = store.loadTaskState(taskId),
      b = second.loadTaskState("t2" as TaskId);
    a.task.version++;
    b.task.version++;
    expect(
      store.commit(taskId, { ...result(a), capacityVersion: 0 }, 0).ok,
    ).toBe(true);
    const before = snapshotSql();
    expect(
      second.commit(b.task.id, { ...result(b), capacityVersion: 0 }, 0),
    ).toMatchObject({ ok: false, conflict: "capacity_version" });
    expect(snapshotSql()).toEqual(before);
  });
  it("two connections consume each accepted/rejected input exactly once", async () => {
    const store = await seeded(),
      second = await open();
    const first = input(),
      rejected = input("rejected"),
      pending = input("pending");
    for (const i of [first, rejected, pending]) store.enqueueInput(taskId, i);
    expect(store.enqueueInput(taskId, first)).toBe(false);
    const makeResult = () => {
      const next = store.loadTaskState(taskId);
      next.task.version++;
      next.consumedInputIds = [first.id, rejected.id];
      return {
        ...result(next),
        inputs: [
          { inputId: first.id, accepted: true as const, reply: null },
          {
            inputId: rejected.id,
            accepted: false as const,
            error: {
              code: "guard_failed" as const,
              message: "Not ready",
              details: [],
            },
          },
        ],
      };
    };
    const a = makeResult(),
      b = makeResult();
    const outcomes = await Promise.all([
      Promise.resolve().then(() => store.commit(taskId, a, 0)),
      Promise.resolve().then(() => second.commit(taskId, b, 0)),
    ]);
    expect(outcomes.filter((v) => v.ok)).toHaveLength(1);
    expect(store.pendingInputs(taskId)).toEqual([pending]);
    expect(store.inputDisposition(taskId, rejected.id)).toEqual(a.inputs[1]);
    expect(store.loadTaskState(taskId).consumedInputIds).toEqual([
      first.id,
      rejected.id,
    ]);
    expect(() =>
      store.enqueueInput(taskId, {
        ...first,
        command: { type: "cancel", reason: "changed" },
      } as typeof first),
    ).toThrow();
  });
  it("rejects unpersisted input dispositions and restores all earlier writes", async () => {
    const store = await seeded(),
      next = richState(),
      receipt = input();
    next.consumedInputIds = [receipt.id];
    const before = snapshotSql();
    expect(
      store.commit(
        taskId,
        {
          ...result(next),
          inputs: [{ inputId: receipt.id, accepted: true, reply: null }],
        },
        0,
      ),
    ).toMatchObject({ conflict: "input_consumed" });
    expect(snapshotSql()).toEqual(before);
  });
  it("accepts a no-op result at the original version and rejects changed unversioned results", async () => {
    const store = await seeded(),
      state = store.loadTaskState(taskId);
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    state.task.title = "Changed";
    expect(() => store.commit(taskId, result(state), 0)).toThrow("increment");
  });
  it("commits actual core transitions, artifacts and action results", async () => {
    const store = await seeded();
    const move = {
      ...input(),
      command: { type: "move" as const, to: "todo" as const },
    };
    store.enqueueInput(taskId, move);
    const state = store.loadTaskState(taskId),
      observations = coreFixture().observations;
    observations.inputs = store.pendingInputs(taskId);
    observations.git = null;
    observations.github = null;
    observations.runs = [];
    observations.capacity.version = 0;
    const planned = reconcile(state, observations);
    expect(store.commit(taskId, planned, state.task.version).ok).toBe(true);
    expect(store.transitions(taskId)).toEqual(planned.transitions);
    const claimed = required(store.outbox.claim(now));
    expect(claimed.action?.kind).toBe("create_worktree");
    const receipt = {
      id: "result-1" as InputId,
      type: "action_result" as const,
      key: claimed.key,
      receivedAt: now,
      result: {
        kind: "create_worktree" as const,
        ok: true as const,
        output: {
          path: "/tmp/loom/t1" as never,
          headSha: "a".repeat(40) as never,
          baseSha: "b".repeat(40) as never,
        },
      },
    };
    expect(
      store.outbox.finish(claimed.key, claimed.claimVersion, receipt),
    ).toBe(true);
    const loaded = store.loadTaskState(taskId);
    observations.inputs = store.pendingInputs(taskId);
    const applied = reconcile(loaded, observations);
    expect(store.commit(taskId, applied, loaded.task.version).ok).toBe(true);
    expect(store.loadTaskState(taskId).worktree?.path).toBe(
      receipt.result.output.path,
    );
    expect(
      store.loadTaskState(taskId).outbox.find((o) => o.key === claimed.key)
        ?.status,
    ).toBe("succeeded");
  });
  it("preserves unknown additive JSON fields on rollback builds", async () => {
    const store = await seeded(),
      connection = db();
    connection
      .prepare(
        "UPDATE tasks SET data = json_set(data, '$.future', 42, '$.attention.future', 'keep') WHERE id = ?",
      )
      .run(taskId);
    connection.close();
    const state = store.loadTaskState(taskId);
    state.task.version++;
    state.task.title = "Updated";
    store.commit(taskId, result(state), 0);
    const read = db();
    const data = JSON.parse(
      read.prepare("SELECT data FROM tasks").pluck().get() as string,
    );
    read.close();
    expect(data.future).toBe(42);
    expect(data.attention.future).toBe("keep");
  });
  it("fails loading corrupt/missing required context and artifact contents", async () => {
    const store = await seeded();
    store.commit(taskId, result(richState()), 0);
    const connection = db();
    connection
      .prepare("UPDATE artifacts SET content = '{}' WHERE kind = 'plan'")
      .run();
    expect(() => store.loadTaskState(taskId)).toThrow("hash");
    connection.prepare("DELETE FROM task_context").run();
    connection.close();
    expect(() => store.loadTaskState(taskId)).toThrow();
  });
  it("reads dependency stages and retains answered questions and ended run history", async () => {
    const store = await seeded();
    store.createTask({ ...task("dependent" as TaskId), blockedBy: [taskId] });
    expect(store.dependencyStages("dependent" as TaskId)).toEqual([
      { taskId, stage: "backlog", merged: false },
    ]);
    const next = richState();
    next.task.stage = "done";
    next.task.attention = { reasons: [], reasonSince: {}, since: null };
    required(next.questions[0]).answer = "One";
    required(next.questions[0]).answeredAt = now;
    required(next.messages[0]).status = "failed";
    required(next.approvals[0]).voidedAt = now;
    store.commit(taskId, result(next), 0);
    const loaded = store.loadTaskState(taskId);
    expect(loaded.questions).toEqual([]);
    expect(loaded.messages).toEqual([]);
    expect(loaded.approvals).toEqual([]);
    expect(store.dependencyStages("dependent" as TaskId)[0]?.merged).toBe(true);
    const connection = db();
    expect(
      connection.prepare("SELECT COUNT(*) FROM questions").pluck().get(),
    ).toBe(1);
    connection.close();
  });
});

describe("immutable artifact projections", () => {
  it("materializes exact older versions and repairs files after a crash", async () => {
    const store = await seeded(),
      state = richState();
    store.commit(taskId, result(state), 0);
    const old = required(state.artifacts[0]);
    const next = store.loadTaskState(taskId);
    next.task.version++;
    artifact(next, "plan", { changed: true });
    store.commit(taskId, result(next), 1);
    rmSync(join(store.dataDirectory, old.path));
    store.materializeArtifact(taskId, "plan", 1);
    expect(store.artifact(taskId, "plan", 1).content).toEqual(state.plan);
    expect(
      JSON.parse(readFileSync(join(store.dataDirectory, old.path), "utf8")),
    ).toEqual(state.plan);
    writeFileSync(join(store.dataDirectory, old.path), "corrupt projection");
    store.close();
    const restarted = await open();
    expect(
      JSON.parse(readFileSync(join(restarted.dataDirectory, old.path), "utf8")),
    ).toEqual(state.plan);
  });
  it("rolls back changed immutable versions and blocks escaping artifact paths", async () => {
    const store = await seeded(),
      state = richState();
    store.commit(taskId, result(state), 0);
    const next = store.loadTaskState(taskId);
    next.task.version++;
    required(next.artifacts[0]).path = "../../escape.json";
    const before = snapshotSql();
    expect(() => store.commit(taskId, result(next), 1)).toThrow("path");
    expect(snapshotSql()).toEqual(before);
  });
  it("reports projection failure as committed and repairs it without replaying the commit", async () => {
    const store = await seeded();
    symlinkSync(root, join(store.dataDirectory, "tasks"));
    const committed = store.commit(taskId, result(richState()), 0);
    expect(committed.ok).toBe(true);
    if (committed.ok) expect(committed.materializationErrors).toHaveLength(2);
    expect(store.loadTaskState(taskId).task.version).toBe(1);
    rmSync(join(store.dataDirectory, "tasks"));
    store.repairArtifactFiles();
    expect(
      readFileSync(join(store.dataDirectory, "tasks/t1/plan/v1.json"), "utf8"),
    ).toContain("Make the change");
  });
});

it("fails loading when an artifact named by the durable manifest is missing", async () => {
  const store = await seeded();
  store.commit(taskId, result(richState()), 0);
  const connection = db();
  connection.prepare("DELETE FROM artifacts WHERE kind = 'plan'").run();
  connection.close();
  expect(() => store.loadTaskState(taskId)).toThrow("manifest");
});

it("accepts multiple artifact revisions within a single pure reconcile result", async () => {
  const store = await seeded();
  const next = store.loadTaskState(taskId);
  next.task.version++;
  artifact(next, "decisions", ["first"]);
  artifact(next, "decisions", ["first", "second"]);
  expect(store.commit(taskId, result(next), 0).ok).toBe(true);
  expect(store.artifact(taskId, "decisions", 2).content).toEqual([
    "first",
    "second",
  ]);
  expect(() => store.artifact(taskId, "decisions", 1)).toThrow();
});

it("rejects missing intermediate artifact content without committing dangling file actions", async () => {
  const store = await seeded();
  const next = richState();
  artifact(next, "decisions", ["first"]);
  artifact(next, "decisions", ["first", "second"]);
  const action = {
    key: "files:v1" as import("@loom/core").ActionKey,
    taskId,
    kind: "write_task_files" as const,
    worktreePath: required(next.worktree).path,
    artifacts: [{ kind: "decisions" as const, version: 1 }],
  };
  next.outbox.push({
    key: action.key,
    kind: action.kind,
    action,
    status: "pending",
    attempts: 0,
    createdAt: now,
    finishedAt: null,
  });
  const before = snapshotSql();
  expect(() =>
    store.commit(taskId, { ...result(next), actions: [action] }, 0),
  ).toThrow("one at a time");
  expect(snapshotSql()).toEqual(before);
  store.enqueueInput(taskId, input("one"));
  store.enqueueInput(taskId, input("two"));
  expect(store.pendingInputs(taskId).map((i) => i.id)).toEqual(["one"]);
  expect(store.pendingInputs(taskId, 2)).toHaveLength(2);
});

describe("diagnostic readers", () => {
  it("keeps all runs and messages while the reconcile snapshot stays filtered", async () => {
    const store = await seeded();
    const state = richState();
    const old = {
      ...required(state.runs[2]),
      id: "old-reviewer" as never,
      sessionId: "old-session" as never,
      status: "ended" as const,
      endedAt: now,
      endReason: "submitted" as const,
    };
    const latest = {
      ...old,
      id: "latest-reviewer" as never,
      sessionId: "latest-session" as never,
    };
    state.runs = [old, ...state.runs, latest];
    const delivered = {
      ...required(state.messages[0]),
      id: "delivered" as never,
      runId: old.id,
      status: "delivered" as const,
      delivered: {
        via: "claude_user_prompt_submit" as const,
        promptId: "p1",
        at: now,
      },
    };
    state.messages.push(delivered);
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    expect(store.runs(taskId)).toEqual(state.runs);
    expect(store.messages(taskId)).toEqual(state.messages);
    expect(store.loadTaskState(taskId).runs).not.toContainEqual(old);
    expect(store.loadTaskState(taskId).messages).not.toContainEqual(delivered);
    const other = "other" as TaskId;
    store.createTask(task(other));
    expect(store.runs(other)).toEqual([]);
    expect(store.messages(other)).toEqual([]);
  });

  it("opens diagnostics without startup writes and refuses database mutations", async () => {
    const store = await seeded();
    const state = richState();
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    const file = join(store.dataDirectory, required(state.artifacts[0]).path);
    rmSync(file);
    const before = snapshotSql();
    const reader = openReadOnlyStore({
      dataRoot: root,
      instance: "dev",
      config,
    });
    stores.push(reader);
    expect(reader.loadTaskState(taskId)).toEqual(state);
    expect(() => reader.createTask(task("other" as TaskId))).toThrow(
      /readonly/,
    );
    expect(() => readFileSync(file)).toThrow();
    expect(snapshotSql()).toEqual(before);
    expect(() =>
      openReadOnlyStore({ dataRoot: root, instance: "absent", config }),
    ).toThrow();
    expect(() =>
      openReadOnlyStore({ dataRoot: root, instance: "../dev", config }),
    ).toThrow();
  });
});

describe("schema drift detection", () => {
  it("retains the Automatic permission occurrence when decoding an outbox action", () => {
    const expectedDialog = {
      requestId: "request-1",
      at: "2026-09-12T00:00:00.000Z",
      command: "pnpm install",
      sessionEpoch: 3,
    };
    const action = {
      key: "automatic-permission",
      taskId: "task-1",
      kind: "answer_pane_prompt",
      runId: "run-1",
      choice: 1,
      expectedDialog,
    };
    expect(actionSchema.parse(JSON.parse(JSON.stringify(action)))).toEqual(
      action,
    );
    expect(
      actionSchema.safeParse({
        ...action,
        expectedDialog: { ...expectedDialog, sessionEpoch: -1 },
      }).success,
    ).toBe(false);
  });
  it("stores the answer_pane_prompt action kind in schema", () => {
    // Verify that answer_pane_prompt is in the store's actionKind enum
    // This test ensures the fix for the regression is in place
    expect(actionKind.options).toContain("answer_pane_prompt");
  });

  it("includes all expected action kinds", () => {
    // This test serves as a regression detector for schema drift.
    // If a new action kind is added to core but not to the store schema,
    // the list of options will differ.
    const expected = [
      "create_worktree",
      "write_task_files",
      "open_workspace",
      "start_run",
      "send_message",
      "interrupt_run",
      "answer_pane_prompt",
      "answer_provider_request",
      "stop_run",
      "push_branch",
      "open_pr",
      "merge_pr",
      "map_findings",
      "disable_auto_merge",
      "refresh",
      "schedule",
      "notify",
    ].sort();
    const actual = actionKind.options.sort();
    expect(actual).toEqual(expected);
  });
});

it("remembers one selected repository per instance across reopen and refuses unknown IDs", async () => {
  const store = await open();
  expect(store.selectedRepo()).toBeNull();
  store.putRepo(repo);
  expect(store.selectedRepo()).toBe(repo.id);
  const second = {
    ...repo,
    id: "another" as typeof repo.id,
    root: "/tmp/another" as typeof repo.root,
  };
  store.putRepo(second);
  expect(store.selectedRepo()).toBe(repo.id);
  store.selectRepo(second.id);
  expect(() => store.selectRepo("missing")).toThrow(
    "Unknown registered repository",
  );
  expect((await open()).selectedRepo()).toBe(second.id);
  expect((await open("other")).selectedRepo()).toBeNull();
});

it("persists inline-review publication and fixing/escalation evidence across restart", async () => {
  const store = await seeded();
  const state = richState();
  const sha = required(state.review).headSha;
  required(state.review).publicationPending = true;
  required(state.review).reviewerCommits = [sha];
  const fixed = required(state.findings[0]);
  fixed.status = "fixed";
  fixed.blocking = false;
  fixed.resolution = {
    by: "reviewer",
    commitSha: sha,
    note: "Fixed actual bug",
    at: now,
  };
  state.findings.push({
    ...fixed,
    id: "escalated" as typeof fixed.id,
    status: "escalate",
    blocking: true,
    resolution: {
      by: "reviewer",
      commitSha: null,
      note: "Requires a design change",
      at: now,
    },
  });
  artifact(state, "findings", state.findings);
  expect(store.commit(taskId, result(state), 0).ok).toBe(true);
  store.close();
  const restored = (await open()).loadTaskState(taskId);
  expect(restored.review).toEqual(state.review);
  expect(restored.findings).toEqual(expect.arrayContaining(state.findings));
  expect(restored.findings).toHaveLength(state.findings.length);
});

it("PR pins and explicit issue links survive reopening without changing the task", async () => {
  const store = await seeded();
  const before = store.loadTaskState(taskId);
  store.setPullRequestPreferences(repo.id, 42, { pinned: true });
  store.setPullRequestPreferences(repo.id, 42, { taskId });
  store.setPullRequestPreferences(repo.id, 42, { taskId });
  store.close();
  const reopened = await open();
  expect(reopened.pullRequestPreferences(repo.id, 42)).toEqual({
    pinned: true,
    taskId,
  });
  expect(reopened.loadTaskState(taskId)).toEqual(before);
  expect(reopened.linkedPullRequests(repo.id, taskId)).toEqual([42]);
  expect(reopened.linkedPullRequests("another-repo", taskId)).toEqual([]);
  expect(reopened.pullRequestPreferences(repo.id, 43)).toEqual({
    pinned: false,
    taskId: null,
  });
  expect(() =>
    reopened.setPullRequestPreferences(repo.id, 42, {
      taskId: "missing" as TaskId,
    }),
  ).toThrow("repository");
  reopened.setPullRequestPreferences(repo.id, 42, { pinned: false });
  expect(reopened.pullRequestPreferences(repo.id, 42)).toEqual({
    pinned: false,
    taskId,
  });
});

it("PR viewed files survive store reopen, merge per file, and reset for another head", async () => {
  const store = await seeded();
  const { pullRequestReviewChange } = await import("@loom/protocol");
  const headSha = "a".repeat(40);
  const save = (path: string) =>
    pullRequestReviewChange.parse({
      kind: "save_review_state",
      repoId: repo.id,
      number: 42,
      change: { headSha, viewed: [{ fileId: path, path, headSha, at: now }] },
    });
  store.savePullRequestReviewState(save("one.ts"));
  store.savePullRequestReviewState(save("two.ts"));
  store.savePullRequestReviewState(save("one.ts"));
  expect(
    store.pullRequestViewedFiles(repo.id, 42, headSha).map((f) => f.path),
  ).toEqual(["one.ts", "two.ts"]);
  store.close();
  const reopened = await open();
  expect(reopened.pullRequestViewedFiles(repo.id, 42, headSha)).toHaveLength(2);
  expect(reopened.pullRequestViewedFiles(repo.id, 43, headSha)).toEqual([]);
  expect(reopened.pullRequestViewedFiles(repo.id, 42, "b".repeat(40))).toEqual(
    [],
  );
  reopened.savePullRequestReviewState(
    pullRequestReviewChange.parse({
      kind: "save_review_state",
      repoId: repo.id,
      number: 42,
      change: { headSha, unviewed: ["one.ts"] },
    }),
  );
  expect(
    reopened.pullRequestViewedFiles(repo.id, 42, headSha).map((f) => f.path),
  ).toEqual(["two.ts"]);
});
