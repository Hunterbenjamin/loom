import type { Task } from "@loom/core";
import { describe, expect, it } from "vitest";
import type { Change } from "./patch.js";
import { stateFromSnapshot } from "./patch.js";
import {
  filterChanges,
  inScope,
  scopeOf,
  subscription,
  taskInScope,
  taskInView,
} from "./subscriptions.js";
import { id, meta, snapshot } from "./test-support.js";
import { changesKey } from "./views.js";

const body = snapshot();
const needsYou = body.tasks[0] as Task;
const done = body.tasks[1] as Task;
const other = id.task("LOOM-999");

describe("views", () => {
  it("puts each sample task where the sidebar would", () => {
    expect(taskInView(needsYou, "needs_you")).toBe(true);
    expect(taskInView(needsYou, "in_progress")).toBe(true);
    expect(taskInView(needsYou, "done")).toBe(false);
    expect(taskInView(done, "done")).toBe(true);
    expect(taskInView(done, "needs_you")).toBe(false);
    expect(taskInView(done, "all")).toBe(true);
  });

  it("filters the task list by view and repo", () => {
    const scope = scopeOf([
      { kind: "views", views: ["needs_you"], repoIds: null },
    ]);
    expect(taskInScope(scope, needsYou)).toBe(true);
    expect(taskInScope(scope, done)).toBe(false);

    const elsewhere = scopeOf([
      { kind: "views", views: ["all"], repoIds: [id.repo("repo-herdr")] },
    ]);
    expect(taskInScope(elsewhere, needsYou)).toBe(false);
  });

  it("sends every task to a client that named no view", () => {
    const scope = scopeOf([]);
    expect(taskInScope(scope, needsYou)).toBe(true);
    expect(taskInScope(scope, done)).toBe(true);
  });
});

describe("scope", () => {
  const taskScope = scopeOf([{ kind: "task", taskId: needsYou.id }]);

  const upsert = (collection: Change["collection"], value: unknown): Change =>
    ({ op: "upsert", collection, value }) as Change;

  it("streams headless agents and questions without subscribing to every task detail", () => {
    const scope = scopeOf([{ kind: "agents" }]);
    expect(inScope(scope, upsert("run", body.runs[0]))).toBe(true);
    expect(inScope(scope, upsert("question", body.questions[0]))).toBe(true);
    expect(inScope(scope, upsert("finding", body.findings[0]))).toBe(false);
    expect(
      inScope(scope, {
        op: "delete",
        collection: "run",
        key: id.run("removed"),
        taskId: other,
      }),
    ).toBe(true);
  });

  it("gives every client the repo list", () => {
    expect(inScope(scopeOf([]), upsert("repo", body.repos[0]))).toBe(true);
  });

  it("sends a task's own rows only to a client showing that task", () => {
    const finding = upsert("finding", body.findings[0]);
    expect(inScope(taskScope, finding)).toBe(true);
    expect(inScope(scopeOf([{ kind: "task", taskId: other }]), finding)).toBe(
      false,
    );
    expect(
      inScope(
        scopeOf([{ kind: "views", views: ["all"], repoIds: null }]),
        finding,
      ),
    ).toBe(false);
  });

  it("keeps a task row flowing to a detail view that left the list", () => {
    const scope = scopeOf([
      { kind: "views", views: ["done"], repoIds: null },
      { kind: "task", taskId: needsYou.id },
    ]);
    expect(inScope(scope, upsert("task", needsYou))).toBe(true);
  });

  it("sends a run's pane state to a terminal panel with no task subscription", () => {
    const scope = scopeOf([
      { kind: "run", runId: id.run("LOOM-101/implementer/0") },
    ]);
    expect(inScope(scope, upsert("run_target", body.runTargets[0]))).toBe(true);
    expect(inScope(scope, upsert("run", body.runs[0]))).toBe(true);
    expect(inScope(scope, upsert("run", body.runs[1]))).toBe(false);
    expect(inScope(scope, upsert("finding", body.findings[0]))).toBe(false);
  });

  it("matches a diff subscription on the range, not just the task", () => {
    const whole = scopeOf([
      { kind: "diff", taskId: needsYou.id, mode: "whole_branch" },
    ]);
    const since = scopeOf([
      { kind: "diff", taskId: needsYou.id, mode: "since_last_review" },
    ]);
    const changes = upsert("changes", body.changes[0]);
    expect(inScope(whole, changes)).toBe(true);
    expect(inScope(since, changes)).toBe(false);
    expect(inScope(taskScope, changes)).toBe(false);
    expect(changesKey(needsYou.id, "whole_branch")).toBe(
      "LOOM-101#whole_branch",
    );
  });

  it("filters a patch down to what the client asked for, in order", () => {
    const client = stateFromSnapshot(meta, body);
    const changes: Change[] = [
      upsert("repo", body.repos[0]),
      upsert("finding", body.findings[0]),
      upsert("changes", body.changes[0]),
      {
        op: "delete",
        collection: "thread",
        key: id.thread("LOOM-101-th1"),
        taskId: other,
      },
    ];
    expect(filterChanges(taskScope, changes)).toEqual([changes[0], changes[1]]);
    expect(client.collections.task.size).toBe(2);
  });
});

describe("the subscription schema", () => {
  it("round-trips each kind", () => {
    const subs = [
      { kind: "views", views: ["needs_you", "done"], repoIds: null },
      { kind: "task", taskId: needsYou.id },
      { kind: "diff", taskId: needsYou.id, mode: "since_last_review" },
      { kind: "run", runId: id.run("LOOM-101/implementer/0") },
    ];
    for (const sub of subs)
      expect(subscription.parse(JSON.parse(JSON.stringify(sub)))).toEqual(sub);
  });

  it("refuses an empty view list and an empty repo filter", () => {
    expect(
      subscription.safeParse({ kind: "views", views: [], repoIds: null })
        .success,
    ).toBe(false);
    expect(
      subscription.safeParse({ kind: "views", views: ["all"], repoIds: [] })
        .success,
    ).toBe(false);
  });
});
