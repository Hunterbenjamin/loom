import { expect, test } from "vitest";
import {
  actionInput,
  base,
  command,
  finding,
  fixed,
  fixture,
  head,
  mcp,
  now,
  reviewCall,
} from "../test/fixtures.js";
import type { Sha } from "./ids.js";

function setup(stage: "ci" | "in_review" | "awaiting_approval") {
  const f = fixture(stage);
  if (
    !f.observations.git?.ok ||
    !f.observations.github?.ok ||
    !f.observations.github.value
  )
    throw new Error("Missing fixture owners");
  const git = f.observations.git.value;
  const pr = f.observations.github.value;
  if (stage === "ci") {
    f.state.ciGate = { headSha: head, since: now };
    f.observations.ci = { ok: true, at: now, value: pr.ci };
  }
  return { ...f, git, pr };
}

test.each(["ci", "in_review", "awaiting_approval"] as const)(
  "%s routes a local conflict once and retires the reviewer before replacement",
  (stage) => {
    const f = setup(stage);
    f.git.conflictsWithBase = true;
    f.state.task.reviewRound = 3;
    const r = fixed(f.state, f.observations);
    expect(r.next.task.stage).toBe("in_progress");
    expect(r.next.task.reviewRound).toBe(3);
    expect(r.next.desiredRun?.fixReason).toContain("Merge main");
    expect(r.next.desiredRun?.retireRunId).toBe("t1/reviewer/1");
    expect(r.actions.some((a) => a.kind === "start_run")).toBe(false);
    expect(r.next.runs.find((run) => run.role === "reviewer")?.endedAt).toBe(
      now,
    );
    expect(r.next.review?.nextRoundForBaseSync).toBe(
      stage === "ci" ? undefined : true,
    );
  },
);

test("PR-only conflicts route before CI launches a reviewer, while old PR heads do not", () => {
  const f = setup("ci");
  f.pr.mergeable = "conflicting";
  expect(fixed(f.state, f.observations).next.task.stage).toBe("in_progress");
  f.pr.headSha = base;
  expect(fixed(f.state, f.observations).next.task.stage).toBe("in_review");
});

test("unknown mergeability does not freeze green CI when local evidence is unavailable", () => {
  const f = setup("ci");
  f.pr.mergeable = "unknown";
  f.git.conflictsWithBase = null;
  const r = fixed(f.state, f.observations);
  expect(r.next.task.stage).toBe("in_review");
  expect(r.next.task.reviewRound).toBe(f.state.task.reviewRound + 1);
});

test("a clean base merge before review pushes without force and gates the new head on CI", () => {
  const f = setup("ci");
  f.git.currentBaseSha = base;
  f.git.behindBase = 1;
  // GitHub can still describe the previous mergeability while local git proves a clean merge.
  f.pr.mergeable = "conflicting";
  const r = fixed(f.state, f.observations);
  const merge = r.actions.find((a) => a.kind === "merge_base");
  if (!merge) throw new Error("Missing base merge");
  const row = r.next.outbox.find((a) => a.key === merge.key);
  expect(row?.dependsOn).toContain(
    r.actions.find((a) => a.kind === "stop_run" && a.runId === "t1/reviewer/1")
      ?.key,
  );
  expect(r.next.desiredRun).toBeNull();
  expect(r.next.outbox.filter((a) => a.kind === "merge_base")).toHaveLength(1);
  const newHead = "c".repeat(40) as Sha;
  f.git.headSha = newHead;
  f.git.behindBase = 0;
  f.observations.inputs = [
    actionInput(merge, { headSha: newHead, conflicting: false }),
  ];
  const merged = fixed(r.next, f.observations);
  expect(merged.next.task.stage).toBe("ci");
  expect(merged.next.ciGate?.headSha).toBe(newHead);
  expect(merged.actions.find((a) => a.kind === "push_branch")).toMatchObject({
    expectedHeadSha: newHead,
    nonForce: true,
  });
  expect(merged.actions.some((a) => a.kind === "start_run")).toBe(false);

  f.pr.headSha = newHead;
  f.pr.ci.headSha = newHead;
  f.git.remoteHeadSha = newHead;
  f.observations.inputs = [];
  const green = fixed(merged.next, f.observations);
  expect(green.next.task.stage).toBe("in_review");
  expect(green.next.task.reviewRound).toBe(f.state.task.reviewRound + 1);
  expect(green.next.review?.headSha).toBe(newHead);
  expect(green.next.review?.baseSyncRounds).toBe(0);
});

test("base movement does not consume the review cap, but a subsequent substantive round does", () => {
  const f = setup("ci");
  f.state.task.reviewRound = 3;
  f.state.task.reviewRoundCap = 3;
  if (!f.state.review) throw new Error("Missing review");
  f.state.review.baseSyncRounds = 1;
  f.state.review.nextRoundForBaseSync = true;
  const r = fixed(f.state, f.observations);
  expect(r.next.task.reviewRound).toBe(4);
  expect(r.next.review?.baseSyncRounds).toBe(2);
  const reviewer = r.next.runs.find(
    (run) => run.role === "reviewer" && run.round === 4,
  );
  if (!reviewer) throw new Error("Missing reviewer");
  const input = mcp(reviewCall([finding("f1")]), "reviewer");
  input.runId = reviewer.id;
  const escalated = fixed(r.next, { ...f.observations, inputs: [input] });
  expect(escalated.next.task.blocked).toBeNull();
  expect(escalated.next.task.stage).toBe("in_progress");
  escalated.next.ciGate = { headSha: head, since: now };
  const next = fixed(escalated.next, { ...f.observations, inputs: [] });
  expect(
    next.next.task.reviewRound - (next.next.review?.baseSyncRounds ?? 0),
  ).toBe(3);
});

test("clean base movement preserves the reviewed head and permits approval", () => {
  const f = setup("awaiting_approval");
  f.git.currentBaseSha = base;
  f.git.behindBase = 1;
  f.observations.inputs = [command({ type: "approve", headSha: head })];
  const r = fixed(f.state, f.observations);
  expect(r.next.task.stage).toBe("merging");
  expect(r.inputs[0]?.accepted).toBe(true);
  expect(r.next.review?.lastReviewedHead).toBe(head);
  expect(r.next.task.reviewRound).toBe(f.state.task.reviewRound);
  expect(r.actions.some((a) => a.kind === "merge_base")).toBe(false);
});

test("a conflict found by the merge executor starts a fix run without changing the cap", () => {
  const f = setup("ci");
  f.git.currentBaseSha = base;
  f.git.behindBase = 1;
  const r = fixed(f.state, f.observations);
  const merge = r.actions.find((a) => a.kind === "merge_base");
  if (!merge) throw new Error("Missing merge action");
  f.observations.inputs = [
    actionInput(merge, { headSha: head, conflicting: true }),
  ];
  const result = fixed(r.next, f.observations);
  expect(result.next.task.stage).toBe("in_progress");
  expect(result.next.desiredRun?.fixReason).toContain("Merge main");
  expect(result.next.task.reviewRound).toBe(f.state.task.reviewRound);
});

test("a checkout on another branch cannot schedule a base merge or retire its runs", () => {
  const f = setup("in_review");
  f.git.branch = "main";
  f.git.currentBaseSha = base;
  f.git.behindBase = 1;
  const r = fixed(f.state, f.observations);
  expect(
    r.actions.some((a) => a.kind === "merge_base" || a.kind === "stop_run"),
  ).toBe(false);
  expect(r.next.task.stage).toBe("in_review");
});

test.each(["in_review", "awaiting_approval"] as const)(
  "clean base movement preserves %s without restarting review",
  (stage) => {
    const f = setup(stage);
    f.git.currentBaseSha = base;
    f.git.behindBase = 1;
    const r = fixed(f.state, f.observations);
    expect(r.next.task.stage).toBe(stage);
    expect(r.next.review).toEqual(f.state.review);
    expect(r.next.task.reviewRound).toBe(f.state.task.reviewRound);
    expect(
      r.next.runs.find((run) => run.role === "reviewer")?.endedAt,
    ).toBeNull();
    expect(
      r.actions.some((a) => a.kind === "merge_base" || a.kind === "stop_run"),
    ).toBe(false);
  },
);

test.each(["external", "missing", "different_branch", "dirty_behind", "unknown"])(
  "%s does not suppress head-change or CI reconciliation",
  (condition) => {
    for (const stage of ["ci", "awaiting_approval"] as const) {
      const f = setup(stage);
      if (condition === "external") f.state.runs[0]!.origin = "external";
      if (condition === "missing") f.git.exists = false;
      if (condition === "different_branch") f.git.branch = "main";
      if (condition === "dirty_behind") {
        f.git.dirty = true;
        f.git.dirtyPaths = ["edited.txt"];
        f.git.currentBaseSha = base;
        f.git.behindBase = 1;
      }
      if (condition === "unknown") {
        f.pr.mergeable = "unknown";
        f.git.conflictsWithBase = null;
      }
      if (stage === "awaiting_approval") f.pr.headSha = base;
      const r = fixed(f.state, f.observations);
      expect(r.next.task.stage).toBe("in_review");
      expect(r.next.task.reviewRound).toBe(f.state.task.reviewRound + 1);
      expect(r.actions.some((a) => a.kind === "merge_base")).toBe(false);
    }
  },
);

test("an external session does not suppress publication or reviewed-head CI failure", () => {
  const publishing = setup("in_review");
  publishing.state.runs[0]!.origin = "external";
  publishing.state.review!.publicationPending = true;
  publishing.git.currentBaseSha = base;
  publishing.git.behindBase = 1;
  const published = fixed(publishing.state, publishing.observations);
  expect(published.next.task.stage).toBe("awaiting_approval");
  expect(published.next.review?.publicationPending).toBe(false);
  expect(published.next.task.reviewRound).toBe(publishing.state.task.reviewRound);

  const failing = setup("awaiting_approval");
  failing.state.runs[0]!.origin = "external";
  failing.pr.ci.conclusion = "failure";
  const failed = fixed(failing.state, failing.observations);
  expect(failed.next.task.stage).toBe("in_progress");
  expect(failed.next.findings.some((f) => f.source === "ci")).toBe(true);
});
