import { describe, expect, test } from "vitest";
import {
  finding,
  fixed,
  fixture,
  head,
  mcp,
  reviewCall,
} from "../test/fixtures.js";
import type { Sha } from "./ids.js";

const other = "c".repeat(40) as Sha;
/** A checker's clean submission of the round head the CI gate already pushed. */
function checked() {
  const f = fixture("in_review");
  const call = reviewCall();
  if (call.tool !== "submit_review" || !f.observations.git?.ok)
    throw new Error("fixture");
  f.observations.inputs = [mcp(call, "reviewer")];
  return { ...f, call };
}
/** The first round: no PR exists until review converges. */
function firstRound() {
  const f = checked();
  f.state.task.prNumber = null;
  const pr = f.observations.github?.ok ? f.observations.github.value : null;
  if (!pr) throw new Error("fixture");
  f.observations.github = { ok: true, at: f.observations.now, value: null };
  return { ...f, pr };
}

test("a clean review opens the PR and waits for it to be mergeable across restart/replay", () => {
  const f = firstRound();
  const result = fixed(f.state, f.observations);
  expect(result.inputs[0]).toMatchObject({
    accepted: true,
    reply: { value: { openBlocking: 0, next: "in_review" } },
  });
  expect(result.next.review).toMatchObject({
    headSha: head,
    lastReviewedHead: head,
    reviewerCommits: [],
    publicationPending: true,
  });
  expect(result.actions.filter((a) => a.kind === "push_branch")).toMatchObject([
    { expectedHeadSha: head },
  ]);
  expect(result.next.outbox.some((a) => a.kind === "open_pr")).toBe(true);
  expect(result.actions.some((a) => a.kind === "start_run")).toBe(false);
  expect(result.next.artifactContents.handoff).toMatchObject({
    reviewerSubmission: { input: f.call.input },
  });
  f.observations.inputs = [];
  const waiting = fixed(result.next, f.observations);
  expect(waiting.next.task.stage).toBe("in_review");
  expect(waiting.next.task.reviewRound).toBe(1);
  f.observations.github = {
    ok: true,
    at: f.observations.now,
    value: { ...f.pr, mergeable: "unknown" },
  };
  expect(fixed(waiting.next, f.observations).next.task.stage).toBe("in_review");
  f.observations.github = {
    ok: true,
    at: f.observations.now,
    value: { ...f.pr, mergeable: "mergeable" },
  };
  const published = fixed(waiting.next, f.observations);
  expect(published.next.task.stage).toBe("awaiting_approval");
  expect(published.next.review?.publicationPending).toBe(false);
});

test("a reviewed branch that conflicts with base retires the reviewer and sends the implementer to merge base", () => {
  const f = firstRound();
  const result = fixed(f.state, f.observations);
  f.observations.inputs = [];
  f.observations.github = {
    ok: true,
    at: f.observations.now,
    value: { ...f.pr, mergeable: "conflicting" },
  };
  const rebased = fixed(result.next, f.observations);
  expect(rebased.next.task.stage).toBe("in_progress");
  expect(rebased.next.review?.publicationPending).toBe(false);
  expect(rebased.next.desiredRun).toMatchObject({
    role: "implementer",
    round: 1,
    resume: false,
    fixReason: expect.stringContaining("conflicts with"),
  });
  // Reconciling again changes nothing: one retirement request, one stage change.
  const again = fixed(rebased.next, f.observations);
  expect(again.next.task.stage).toBe("in_progress");
  expect(
    again.next.outbox.filter(
      (row) => row.action?.kind === "stop_run" && row.action.terminate,
    ),
  ).toHaveLength(2);
});

describe("checker review guards reject atomically", () => {
  test.each([
    "dirty",
    "untracked",
    "unknown",
    "branch",
    "head",
    "reviewer-commit",
    "fixed-finding",
    "fixed-verdict",
  ])("%s", (kind) => {
    const f = checked();
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
    if (kind === "branch") git.branch = "feat/other";
    if (kind === "head") git.headSha = other;
    if (kind === "reviewer-commit") {
      git.headSha = other;
      git.reviewCommits = { baseSha: head, headSha: other, commits: [other] };
      f.call.input.reviewedSha = other;
      f.call.input.reviewerCommits = [other];
    }
    if (kind === "fixed-finding") {
      f.call.input.findings = [
        {
          severity: "major",
          title: "Wrong value",
          body: "Fixed wrong value",
          status: "fixed",
          commitSha: head,
          location: null,
        },
      ];
      f.call.drafts = [{ id: finding().id, anchor: null }];
    }
    if (kind === "fixed-verdict") {
      f.state.findings = [finding("existing")];
      f.call.input.verdicts = [
        {
          findingId: finding("existing").id,
          status: "fixed",
          commitSha: head,
          note: "Fixed",
        },
      ];
    }
    const before = f.state.findings.map((x) => ({ ...x }));
    const result = fixed(f.state, f.observations);
    expect(result.inputs[0]).toMatchObject({
      accepted: false,
      error: { code: "guard_failed" },
    });
    expect(result.next.findings).toEqual(before);
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
  const f = firstRound();
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
