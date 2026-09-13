import { describe, expect, test } from "vitest";
import {
  actionInput,
  base,
  finding,
  fixed,
  fixture,
  head,
  mcp,
  reviewCall,
} from "../test/fixtures.js";
import type { Sha } from "./ids.js";

const fix = "c".repeat(40) as Sha;
const laterFix = "d".repeat(40) as Sha;
function inline() {
  const f = fixture("in_review");
  const call = reviewCall([finding()]);
  if (call.tool !== "submit_review" || !f.observations.git?.ok)
    throw new Error("fixture");
  call.input.reviewedSha = fix;
  call.input.reviewerCommits = [fix];
  call.input.findings = [
    {
      severity: "major",
      title: "Wrong value",
      body: "Fixed wrong value",
      status: "fixed",
      commitSha: fix,
      location: null,
    },
  ];
  f.observations.git.value.headSha = fix;
  f.observations.git.value.reviewCommits = {
    baseSha: head,
    headSha: fix,
    commits: [fix],
  };
  f.observations.inputs = [mcp(call, "reviewer")];
  return { ...f, call };
}

test("inline fixes persist attribution and wait for the pushed reviewed PR head across restart/replay", () => {
  const f = inline();
  const result = fixed(f.state, f.observations);
  expect(result.inputs[0]).toMatchObject({
    accepted: true,
    reply: { value: { openBlocking: 0, next: "in_review" } },
  });
  expect(result.next.review).toMatchObject({
    headSha: head,
    lastReviewedHead: fix,
    reviewerCommits: [fix],
    publicationPending: true,
  });
  expect(result.next.findings[0]).toMatchObject({
    status: "fixed",
    blocking: false,
    resolution: { commitSha: fix, by: "reviewer" },
  });
  expect(result.actions.filter((a) => a.kind === "push_branch")).toMatchObject([
    { expectedHeadSha: fix },
  ]);
  expect(result.actions.some((a) => a.kind === "start_run")).toBe(false);
  expect(result.next.artifactContents.handoff).toMatchObject({
    reviewerSubmission: { input: f.call.input },
  });
  if (
    !f.observations.git?.ok ||
    !f.observations.github?.ok ||
    !f.observations.github.value
  )
    throw new Error("fixture");
  const push = result.actions.find((a) => a.kind === "push_branch");
  if (!push) throw new Error("Missing push");
  f.observations.inputs = [actionInput(push, { remoteHeadSha: fix })];
  const stale = fixed(result.next, f.observations);
  expect(stale.next.task.stage).toBe("in_review");
  expect(stale.next.task.reviewRound).toBe(1);
  f.observations.github.value.headSha = fix;
  f.observations.github.value.ci.headSha = fix;
  f.observations.github.value.mergeable = "unknown";
  expect(fixed(stale.next, f.observations).next.task.stage).toBe("in_review");
  f.observations.github.value.mergeable = "mergeable";
  const published = fixed(stale.next, f.observations);
  expect(published.next.task.stage).toBe("awaiting_approval");
  expect(published.next.review?.publicationPending).toBe(false);
});

test("a reviewed branch that conflicts with base goes back to the implementer to rebase", () => {
  const f = inline();
  const result = fixed(f.state, f.observations);
  if (!f.observations.github?.ok || !f.observations.github.value)
    throw new Error("fixture");
  const push = result.actions.find((a) => a.kind === "push_branch");
  if (!push) throw new Error("Missing push");
  f.observations.inputs = [actionInput(push, { remoteHeadSha: fix })];
  f.observations.github.value.headSha = fix;
  f.observations.github.value.ci.headSha = fix;
  f.observations.github.value.mergeable = "conflicting";
  const rebased = fixed(result.next, f.observations);
  expect(rebased.next.task.stage).toBe("in_progress");
  expect(rebased.next.review?.publicationPending).toBe(false);
  expect(
    rebased.next.messages.find((m) => m.purpose === "fix_round")?.text,
  ).toMatch(/conflicts with/);
  // Reconciling again changes nothing: one message, one stage change.
  const again = fixed(rebased.next, f.observations);
  expect(again.next.task.stage).toBe("in_progress");
  expect(
    again.next.messages.filter((m) => m.purpose === "fix_round"),
  ).toHaveLength(1);
});

describe("inline review guards reject atomically", () => {
  test.each([
    "dirty",
    "untracked",
    "unknown",
    "unrelated",
    "omitted",
    "extra",
    "duplicate",
    "order",
    "fix-outside-range",
    "branch",
    "head",
  ])("%s", (kind) => {
    const f = inline();
    if (!f.observations.git?.ok) throw new Error("fixture");
    const git = f.observations.git.value;
    if (kind === "dirty") git.dirty = true;
    if (kind === "untracked") git.dirtyPaths = ["untracked.ts"];
    if (kind === "unknown")
      f.observations.git = {
        ok: false,
        reason: "unavailable",
        at: f.observations.now,
      };
    if (kind === "unrelated") git.reviewCommits = null;
    if (kind === "omitted") f.call.input.reviewerCommits = [];
    if (kind === "extra") f.call.input.reviewerCommits.push(base);
    if (kind === "duplicate") f.call.input.reviewerCommits.push(fix);
    if (kind === "order") {
      git.headSha = laterFix;
      git.reviewCommits = {
        baseSha: head,
        headSha: laterFix,
        commits: [fix, laterFix],
      };
      f.call.input.reviewedSha = laterFix;
      f.call.input.reviewerCommits = [laterFix, fix];
    }
    if (kind === "fix-outside-range")
      Object.assign(f.call.input.findings[0] ?? {}, { commitSha: head });
    if (kind === "branch") git.branch = "feat/other";
    if (kind === "head") git.headSha = head;
    const result = fixed(f.state, f.observations);
    expect(result.inputs[0]).toMatchObject({
      accepted: false,
      error: { code: "guard_failed" },
    });
    expect(result.next.findings).toEqual([]);
    expect(result.next.review?.lastReviewedHead).toBe(
      f.state.review?.lastReviewedHead,
    );
    expect(result.actions.some((a) => a.kind === "push_branch")).toBe(false);
  });
});

test("severity alone never sends an implementer fix round", () => {
  const f = fixture("in_review");
  const call = reviewCall([finding()]);
  if (call.tool !== "submit_review") throw new Error("fixture");
  Object.assign(call.input.findings[0] ?? {}, { status: "open" });
  delete call.input.findings[0]?.reason;
  f.observations.inputs = [mcp(call, "reviewer")];
  const result = fixed(f.state, f.observations);
  expect(result.next.task.stage).toBe("awaiting_approval");
  expect(result.next.findings[0]).toMatchObject({
    severity: "major",
    status: "open",
    blocking: false,
  });
});

test("reviewer may fix an existing open blocker and records the fixing verdict", () => {
  const f = inline();
  f.state.findings = [finding("existing")];
  f.call.input.verdicts = [
    {
      findingId: finding("existing").id,
      status: "fixed",
      commitSha: fix,
      note: "Fixed",
    },
  ];
  const result = fixed(f.state, f.observations);
  expect(result.inputs[0]).toMatchObject({ accepted: true });
  expect(result.next.findings[0]).toMatchObject({
    status: "fixed",
    blocking: false,
    resolution: { commitSha: fix },
  });
});

test("escalation needs a reason even when core is called without MCP", () => {
  const f = fixture("in_review");
  const call = reviewCall([finding()]);
  if (call.tool !== "submit_review") throw new Error("fixture");
  delete call.input.findings[0]?.reason;
  f.observations.inputs = [mcp(call, "reviewer")];
  expect(fixed(f.state, f.observations).inputs[0]).toMatchObject({
    accepted: false,
    error: { code: "guard_failed" },
  });
});

test("an existing open blocker may be escalated without inventing a reopened fix", () => {
  const f = fixture("in_review");
  const existing = finding("existing", { source: "human" });
  f.state.findings = [existing];
  const call = reviewCall();
  if (call.tool !== "submit_review") throw new Error("fixture");
  call.input.verdicts = [
    {
      findingId: existing.id,
      status: "escalate",
      reason: "Requires redesign",
      note: "Unsafe inline",
    },
  ];
  f.observations.inputs = [mcp(call, "reviewer")];
  const result = fixed(f.state, f.observations);
  expect(result.next.task.stage).toBe("in_progress");
  expect(result.next.findings[0]).toMatchObject({
    status: "escalate",
    reopenCount: 0,
    resolution: { note: "Requires redesign" },
  });
});

test("publication dependencies follow replacement keys after canceled intents", () => {
  const f = inline();
  f.state.task.prNumber = null;
  f.observations.github = { ok: true, at: f.observations.now, value: null };
  const submitted = fixed(f.state, f.observations);
  for (const row of submitted.next.outbox) {
    if (row.kind === "push_branch" || row.kind === "open_pr")
      row.status = "canceled";
  }
  const resumed = fixed(submitted.next, f.observations);
  const push = resumed.actions.find((a) => a.kind === "push_branch");
  const open = resumed.next.outbox.find(
    (row) => row.kind === "open_pr" && row.status === "pending",
  );
  expect(push?.key).toContain("#2");
  expect(open?.dependsOn).toContain(push?.key);
  expect(
    open?.dependsOn?.some((key) =>
      submitted.next.outbox.some(
        (row) => row.key === key && row.status === "canceled",
      ),
    ),
  ).toBe(false);
});
