import type {
  Approval,
  Attention,
  BlockedFlag,
  CiState,
  FailedFlag,
  Finding,
  FindingAnchor,
  FindingLocation,
  HumanCommand,
  Message,
  Plan,
  ProviderRequest,
  Question,
  Repo,
  Run,
  Task,
  TestResult,
  Transition,
  Worktree,
} from "@loom/core";
import { describe, expect, expectTypeOf, it, test } from "vitest";
import type { z } from "zod";
import {
  approval,
  attention,
  type blockedFlag,
  type ciState,
  type failedFlag,
  finding,
  type findingAnchor,
  type findingLocation,
  humanCommand,
  type message,
  type plan,
  type providerRequest,
  providerRequestKey,
  question,
  repo,
  run,
  stage,
  task,
  type testResult,
  transition,
  worktree,
} from "./entities.js";
import { snapshotBody } from "./snapshot.js";
import { snapshot } from "./test-support.js";
import {
  changedFile,
  commentThread,
  reviewRange,
  reviewState,
  runTarget,
  taskInbox,
} from "./views.js";

test("every mirror equals the core type it mirrors", () => {
  expectTypeOf<z.output<typeof repo>>().toEqualTypeOf<Repo>();
  expectTypeOf<z.output<typeof task>>().toEqualTypeOf<Task>();
  expectTypeOf<z.output<typeof attention>>().toEqualTypeOf<Attention>();
  expectTypeOf<z.output<typeof blockedFlag>>().toEqualTypeOf<BlockedFlag>();
  expectTypeOf<z.output<typeof failedFlag>>().toEqualTypeOf<FailedFlag>();
  expectTypeOf<z.output<typeof worktree>>().toEqualTypeOf<Worktree>();
  expectTypeOf<z.output<typeof run>>().toEqualTypeOf<Run>();
  expectTypeOf<
    z.output<typeof providerRequest>
  >().toEqualTypeOf<ProviderRequest>();
  // `.optional()` writes `via?: SendVia | undefined` where core writes `via?: SendVia`; with
  // `exactOptionalPropertyTypes` off those are the same type, so assert it in both directions.
  expectTypeOf<z.output<typeof message>>().toExtend<Message>();
  expectTypeOf<Message>().toExtend<z.output<typeof message>>();
  expectTypeOf<z.output<typeof question>>().toEqualTypeOf<Question>();
  expectTypeOf<z.output<typeof plan>>().toEqualTypeOf<Plan>();
  expectTypeOf<z.output<typeof testResult>>().toEqualTypeOf<TestResult>();
  expectTypeOf<z.output<typeof finding>>().toEqualTypeOf<Finding>();
  expectTypeOf<z.output<typeof findingAnchor>>().toEqualTypeOf<FindingAnchor>();
  expectTypeOf<
    z.output<typeof findingLocation>
  >().toEqualTypeOf<FindingLocation>();
  expectTypeOf<z.output<typeof ciState>>().toEqualTypeOf<CiState>();
  expectTypeOf<z.output<typeof approval>>().toEqualTypeOf<Approval>();
  expectTypeOf<z.output<typeof transition>>().toEqualTypeOf<Transition>();
  expectTypeOf<z.output<typeof humanCommand>>().toEqualTypeOf<HumanCommand>();
});

describe("round trips", () => {
  it("carries the whole snapshot through JSON unchanged", () => {
    const body = snapshot();
    const parsed = snapshotBody.parse(JSON.parse(JSON.stringify(body)));
    expect(parsed).toEqual(body);
  });

  it("carries idle submission attention and its interval through a snapshot", () => {
    const body = snapshot();
    const idleRun = body.runs[0];
    const idleTask = body.tasks[0];
    if (!idleRun || !idleTask) throw new Error("missing fixture");
    const at = idleTask.createdAt;
    idleRun.idleSince = at;
    idleTask.attention = {
      reasons: ["idle_without_submission"],
      reasonSince: { idle_without_submission: at },
      since: at,
    };
    expect(snapshotBody.parse(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });

  const cases: [string, z.ZodType, unknown][] = [
    ["repo", repo, snapshot().repos[0]],
    ["task", task, snapshot().tasks[0]],
    ["worktree", worktree, snapshot().worktrees[0]],
    ["run", run, snapshot().runs[0]],
    ["external run with empty model", run, snapshot().runs[1]],
    ["run target", runTarget, snapshot().runTargets[0]],
    ["question", question, snapshot().questions[0]],
    ["finding", finding, snapshot().findings[0]],
    ["approval", approval, snapshot().approvals[0]],
    ["transition", transition, snapshot().transitions[0]],
    ["comment thread", commentThread, snapshot().threads[0]],
    ["review state", reviewState, snapshot().reviewStates[0]],
    ["changed file", changedFile, snapshot().changes[0]?.files[2]],
  ];
  for (const [name, schema, value] of cases)
    it(name, () => {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    });
});

describe("validation at the boundary", () => {
  it("accepts the CI stage and its inbox projection", () => {
    expect(stage.parse("ci")).toBe("ci");
    expect(
      taskInbox.parse({
        taskId: "task-1",
        reasonRuns: {},
        reviewedHead: null,
        planVersion: 1,
        workTime: { startedAt: null, readyAt: null },
        ci: {
          headSha: "a".repeat(40),
          since: "2026-09-12T06:00:00.000Z",
          conclusion: "pending",
          checks: [
            {
              name: "test",
              status: "in_progress",
              conclusion: null,
              url: "https://example.test/run",
            },
          ],
          observedAt: "2026-09-12T06:01:00.000Z",
        },
      }).ci?.checks[0]?.name,
    ).toBe("test");
  });

  it("rejects an attention set whose reasons and reasonSince disagree", () => {
    expect(
      attention.safeParse({
        reasons: ["stalled", "failed"],
        reasonSince: { stalled: "2026-09-12T06:00:00.000Z" },
        since: "2026-09-12T06:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects a since that is not the earliest reason", () => {
    expect(
      attention.safeParse({
        reasons: ["stalled", "failed"],
        reasonSince: {
          stalled: "2026-09-12T06:00:00.000Z",
          failed: "2026-09-12T05:00:00.000Z",
        },
        since: "2026-09-12T06:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects a since_last_review range that does not start at the reviewed head", () => {
    const range = {
      mode: "since_last_review",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      lastReviewedHead: "3".repeat(40),
    };
    expect(reviewRange.safeParse(range).success).toBe(false);
    expect(
      reviewRange.safeParse({ ...range, baseSha: "3".repeat(40) }).success,
    ).toBe(true);
  });

  it("rejects an unknown field rather than dropping it", () => {
    const first = snapshot().repos[0];
    expect(repo.safeParse({ ...first, colour: "red" }).success).toBe(false);
  });

  it("rejects a relative worktree path and a short SHA", () => {
    const first = snapshot().worktrees[0];
    expect(worktree.safeParse({ ...first, path: "wt/x" }).success).toBe(false);
    expect(worktree.safeParse({ ...first, baseSha: "abc" }).success).toBe(
      false,
    );
  });

  it("keys a provider request by generation, because the ID alone repeats", () => {
    const request = snapshot().runs[0]?.pendingRequests[0];
    if (!request) throw new Error("sample changed");
    expect(providerRequestKey(request)).toBe("-:req_88");
    expect(providerRequestKey({ ...request, generation: 4 })).toBe("4:req_88");
  });
});

test("backlog edit validates fields at the protocol boundary", () => {
  const edit = {
    type: "edit_task",
    expectedVersion: 1,
    title: "Title",
    description: "",
    size: "normal",
    requirePlanApproval: true,
  };
  expect(humanCommand.safeParse(edit).success).toBe(true);
  for (const invalid of [
    { title: " " },
    { title: "x".repeat(201) },
    { description: "x".repeat(20001) },
    { size: "huge" },
    { expectedVersion: -1 },
    { requirePlanApproval: "yes" },
  ])
    expect(humanCommand.safeParse({ ...edit, ...invalid }).success).toBe(false);
});
