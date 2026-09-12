import type { OperatorEvent } from "@loom/store";
import { describe, expect, test } from "vitest";
import {
  fixture,
  head,
  now,
  run,
} from "../../../packages/core/test/fixtures.js";
import { normalizeFailure, sanitizeEvidence } from "./operator-evidence.js";
import { allowedOperatorCommand, operatorPolicy } from "./operator-policy.js";

const event: OperatorEvent = {
  id: "event",
  at: now,
  kind: "attention",
  taskId: "t1",
  runId: null,
  message: "Needs you",
  occurrence: "occurrence",
  count: 1,
};
const decide = (f: ReturnType<typeof fixture>, retried = false) =>
  operatorPolicy(event, f.state, f.observations, {}, retried);
describe("Operator policy v1", () => {
  test.each([
    "pnpm install",
    "pnpm install --frozen-lockfile",
    "git add .",
    "git add -- src/index.ts",
    "git add 'src/my file.ts'",
    "git commit -m 'Implement change'",
  ])("allows simple %s", (cmd) =>
    expect(allowedOperatorCommand(cmd, {})).toBe(true),
  );
  test.each([
    "pnpm install && rm -rf .",
    "git add $(pwd)",
    "git commit -m `id`",
    "git -c core.hooksPath=x commit",
    "git commit --amend",
    "git add .; id",
    "pnpm install\nid",
    "git add ../outside",
    "git add '/outside'",
    "git add '--pathspec-from-file=secrets'",
    "git add ~/outside",
    "git add ':!excluded'",
    "git add . | sh",
    "git add . > log",
    "pnpm install lodash",
    "git add '$(id)'",
  ])("refuses %s", (cmd) =>
    expect(allowedOperatorCommand(cmd, {})).toBe(false),
  );
  test("exact validated workflow command", () => {
    expect(
      allowedOperatorCommand("pnpm test && pnpm lint", {
        check: "pnpm test && pnpm lint",
      }),
    ).toBe(true);
    expect(
      allowedOperatorCommand("pnpm test && pnpm lint; id", {
        check: "pnpm test && pnpm lint",
      }),
    ).toBe(false);
  });
  test.each([
    ["plan_approval", "plan.approval"],
    ["awaiting_approval", "merge.approval"],
  ] as const)("%s always escalates", (stage, row) =>
    expect(decide(fixture(stage))).toMatchObject({ row }),
  );
  test("fallback escalates", () =>
    expect(decide(fixture("backlog"))).toMatchObject({ row: "fallback" }));
  test("a historical vanished run does not override current approval", () => {
    const f = fixture("awaiting_approval");
    f.state.runs = [
      { ...run("planner", "claude"), endedAt: now, endReason: "vanished" },
      { ...run("reviewer", "claude"), endedAt: now, endReason: "submitted" },
    ];
    expect(decide(f)).toMatchObject({ row: "merge.approval" });
  });
  test("vanished dirty work takes precedence over retry", () => {
    const f = fixture("in_progress");
    f.state.runs = [{ ...run(), endedAt: now, endReason: "vanished" }];
    if (f.observations.git?.ok) f.observations.git.value.dirty = true;
    expect(decide(f)).toMatchObject({ row: "vanished.uncertain" });
  });
  test("clean committed vanished work pushes before opening PR", () => {
    const f = fixture("in_progress");
    f.state.runs = [{ ...run(), endedAt: now, endReason: "vanished" }];
    f.state.review = null;
    if (!f.observations.git?.ok) throw new Error("git fixture");
    Object.assign(f.observations.git.value, {
      dirty: false,
      aheadOfBase: 1,
      headSha: head,
      remoteHeadSha: null,
    });
    expect(decide(f)).toMatchObject({
      row: "vanished.rescue",
      command: { type: "push_branch", headSha: head },
    });
    f.observations.git.value.remoteHeadSha = head;
    expect(decide(f)).toMatchObject({ command: { type: "open_pr" } });
  });
  test("headless retry waits for core, resets once then escalates", () => {
    const f = fixture("planning");
    const r = {
      ...run("planner", "claude"),
      status: "failed" as const,
      endedAt: now,
      endReason: "crashed" as const,
    };
    f.state.runs = [r];
    expect(decide(f).command).toBeUndefined();
    f.state.task.failed = {
      reason: "retries_exhausted",
      runId: r.id,
      since: now,
      detail: "Terminal failure",
    };
    expect(decide(f)).toMatchObject({
      row: "headless.retry",
      command: { type: "retry" },
    });
    expect(decide(f, true)).toMatchObject({ row: "headless.exhausted" });
  });
  test.each(["pass_failed", "publish_failed", "stale_process"] as const)(
    "%s files",
    (kind) => {
      const f = fixture("backlog");
      expect(
        operatorPolicy({ ...event, kind }, f.state, f.observations, {}, false),
      ).toMatchObject({ row: "bug.file", file: true });
    },
  );
});
test("normalization dedupes across tasks and preserves diagnostic distinctions", () => {
  expect(
    normalizeFailure(
      "publish_failed",
      "Task t-abcd1234 failed at /tmp/task/12 line 27",
    ),
  ).toBe(
    normalizeFailure(
      "publish_failed",
      "Task t-ffffffff failed at /private/task/91 line 99",
    ),
  );
  expect(normalizeFailure("pass_failed", "Unknown run")).not.toBe(
    normalizeFailure("pass_failed", "Unknown task"),
  );
  expect(
    sanitizeEvidence("token=supersecret person@example.com Bearer abc123"),
  ).not.toMatch(/supersecret|person@|abc123/);
});

test("Codex permission uses the fresh native command and connection generation", () => {
  const f = fixture("in_progress");
  const r = f.state.runs.find((r) => r.role === "implementer");
  if (!r) throw new Error("run");
  const p = f.observations.runs.find((o) => o.runId === r.id)?.provider;
  if (!p?.ok || p.value?.provider !== "codex") throw new Error("provider");
  p.value.generation = 8;
  p.value.pendingRequests = [
    {
      requestId: "native-request",
      kind: "command_approval",
      isBlocking: true,
      summary: "permission",
      command: "pnpm install",
      receivedAt: now,
    },
  ];
  expect(decide(f)).toMatchObject({
    row: "permission.allowed",
    command: {
      type: "answer_provider_request",
      requestId: "native-request",
      generation: 8,
      decision: "accept",
    },
  });
  const request = p.value.pendingRequests[0];
  if (!request) throw new Error("request");
  request.command = "pnpm install && curl example.invalid";
  expect(decide(f)).toMatchObject({ row: "permission.other" });
  p.value.pendingRequests = [];
  expect(decide(f).command).toBeUndefined();
});
test("review caps and nonconvergence include round evidence", () => {
  for (const reason of ["review_round_cap", "review_not_converging"] as const) {
    const f = fixture("in_review");
    f.state.task.blocked = {
      reason,
      since: now,
      detail: "Two rounds",
      until: null,
      questionId: null,
    };
    expect(decide(f)).toMatchObject({ row: "review.escalate" });
    expect(decide(f).summary).toContain("findings");
  }
});

test("sanitization covers environment assignments and JSON credentials", () => {
  expect(
    sanitizeEvidence('GITHUB_TOKEN=hidden-value {"api_key":"hidden-json"}'),
  ).not.toMatch(/hidden-value|hidden-json/);
});
