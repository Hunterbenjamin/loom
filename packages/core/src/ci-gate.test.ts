import { describe, expect, it } from "vitest";
import {
  actionInput,
  finding,
  fixed,
  fixture,
  head,
  mcp,
  now,
  reviewCall,
  submit,
} from "../test/fixtures.js";
import { CI_START_GRACE_MS } from "./ci-gate.js";
import { roleOwesWork } from "./helpers.js";
import type { CiState, IsoTime, Observations, Sha } from "./index.js";
import { deriveAttention, reconcile } from "./index.js";

const ci = (
  conclusion: CiState["conclusion"],
  sha: Sha = head,
): Observations["ci"] => ({
  ok: true,
  at: now,
  value: {
    headSha: sha,
    conclusion,
    observedAt: now,
    checks:
      conclusion === "none"
        ? []
        : [
            {
              id: "9001",
              name: "lint-typecheck-test",
              status: conclusion === "pending" ? "in_progress" : "completed",
              conclusion: conclusion === "pending" ? null : conclusion,
              url: "https://example.test/check/9001",
            },
          ],
  },
});

/** An implementer submission in CI, before any reviewer exists for the round. */
function submitted(provider?: "codex" | "claude") {
  const f = fixture("in_progress");
  f.state.task.reviewRound = 0;
  f.state.task.prNumber = null;
  f.state.review = null;
  f.state.runs = f.state.runs.filter((r) => r.role !== "reviewer");
  const implementer = f.state.runs.find((r) => r.role === "implementer");
  if (provider && implementer) {
    implementer.provider = provider;
    f.state.task.providers.implementer = provider;
  }
  if (f.observations.github?.ok) f.observations.github.value = null;
  f.observations.inputs = [mcp(submit())];
  const r = fixed(f.state, f.observations);
  return { f, next: r.next, result: r, obs: { ...f.observations, inputs: [] } };
}

describe("CI gate before review", () => {
  it("a submission is pushed and moves to CI, with no reviewer and no PR", () => {
    const { result, next } = submitted();
    expect(result.inputs[0]?.accepted).toBe(true);
    expect(next.task.stage).toBe("ci");
    expect(next.ciGate).toEqual({ headSha: head, since: now });
    expect(result.transitions.at(-1)?.reason).toBe(
      `Submitted; CI running on ${head.slice(0, 7)}`,
    );
    expect(result.actions.some((a) => a.kind === "push_branch")).toBe(true);
    expect(next.outbox.some((a) => a.kind === "start_run")).toBe(false);
    expect(next.outbox.some((a) => a.kind === "open_pr")).toBe(false);
    expect(next.task.reviewRound).toBe(0);
  });

  it("pending CI keeps waiting", () => {
    const { next, obs } = submitted();
    const r = fixed(next, { ...obs, ci: ci("pending") });
    expect(r.next.task.stage).toBe("ci");
    expect(r.next.ciGate?.headSha).toBe(head);
    expect(r.next.ciGate?.ci?.conclusion).toBe("pending");
  });

  it("red CI requests a fresh implementer round with the failing checks, not review", () => {
    const { next, obs } = submitted();
    const r = fixed(next, { ...obs, ci: ci("failure") });
    expect(r.next.task.stage).toBe("in_progress");
    expect(r.next.ciGate).toBeNull();
    expect(r.next.task.reviewRound).toBe(0);
    const failure = r.next.findings.find((f) => f.source === "ci");
    expect(failure).toMatchObject({
      blocking: true,
      status: "open",
      title: "lint-typecheck-test",
    });
    expect(failure?.body).toContain("https://example.test/check/9001");
    expect(r.next.messages.some((m) => m.purpose === "fix_round")).toBe(false);
    expect(r.next.desiredRun).toMatchObject({
      role: "implementer",
      round: 1,
      resume: false,
      retireRunId: "t1/implementer/0",
      fixReason: expect.stringContaining("lint-typecheck-test"),
    });
    expect(
      r.actions.some(
        (a) => a.kind === "stop_run" && a.runId === "t1/implementer/0",
      ),
    ).toBe(true);
    expect(r.next.outbox.some((a) => a.kind === "start_run")).toBe(false);
    expect(r.transitions.at(-1)?.reason).toContain("lint-typecheck-test");
  });

  it("records a distinct fix-round session only after the previous run retires", () => {
    const { next, obs } = submitted("claude");
    const previous = next.runs.find((run) => run.role === "implementer");
    const red = fixed(next, { ...obs, ci: ci("failure") });
    const stop = red.actions.find(
      (action) => action.kind === "stop_run" && action.terminate,
    );
    if (!stop) throw new Error("Missing implementer retirement");
    expect(red.actions.some((action) => action.kind === "start_run")).toBe(
      false,
    );

    const started = fixed(red.next, {
      ...obs,
      inputs: [actionInput(stop, {})],
    });
    const launch = started.actions.find(
      (action) => action.kind === "start_run",
    );
    expect(launch).toMatchObject({
      runId: "t1/implementer/1",
      provider: "claude",
      sessionId: "uuid:t1/implementer/1#0",
      resume: false,
      attempt: 1,
    });
    const current = started.next.runs.at(-1);
    expect(current?.sessionId).toBe(launch?.sessionId);
    expect(current?.sessionId).not.toBe(previous?.sessionId);
    expect(started.next.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "t1/implementer/1",
          purpose: "initial",
          text: expect.stringContaining(
            "fresh implementer fix-round session 1",
          ),
        }),
      ]),
    );
  });

  it("green CI settles earlier CI failures and starts a review round that owes them no verdict", () => {
    const { next, obs } = submitted();
    const red = fixed(next, { ...obs, ci: ci("failure") });
    red.next.ciGate = { headSha: head, since: now };
    const green = fixed(red.next, { ...obs, ci: ci("success") });
    expect(green.next.task.stage).toBe("in_review");
    expect(green.next.task.reviewRound).toBe(1);
    expect(green.next.ciGate).toBeNull();
    const failure = green.next.findings.find((f) => f.source === "ci");
    expect(failure?.status).toBe("resolved");
    expect(failure?.resolution?.by).toBe("ci");
    expect(green.next.review?.verdictIds).not.toContain(failure?.id);
    expect(green.next.outbox.some((a) => a.kind === "start_run")).toBe(true);
  });

  it("a repository with no CI reaches review only after the push has had time to start one", () => {
    const settle = (finishedAt: IsoTime) => {
      const { next, obs } = submitted();
      const row = next.outbox.find(
        (r) => r.key === `push_branch:${next.task.id}:${head}`,
      );
      if (!row) throw new Error("no push intent");
      row.status = "succeeded";
      row.finishedAt = finishedAt;
      return reconcile(next, { ...obs, ci: ci("none") });
    };
    expect(settle(now).next.task.stage).toBe("ci");
    const early = new Date(
      Date.parse(now) - CI_START_GRACE_MS - 1,
    ).toISOString() as IsoTime;
    expect(settle(early).next.task.stage).toBe("in_review");
  });

  it("new commits after submitting withdraw the gate", () => {
    const { next, obs } = submitted();
    const git =
      obs.git?.ok && obs.git.value
        ? {
            ...obs.git,
            value: { ...obs.git.value, headSha: "c".repeat(40) as Sha },
          }
        : obs.git;
    const r = fixed(next, { ...obs, git, ci: ci("success") });
    expect(r.next.ciGate).toBeNull();
    expect(r.next.task.stage).toBe("in_progress");
    expect(r.transitions.at(-1)?.reason).toBe(
      "New commits on the branch; submission withdrawn",
    );
  });

  it("an idle implementer waiting on CI is not reported as idle without submission", () => {
    const f = fixture("ci");
    const run = f.state.runs.find((r) => r.role === "implementer");
    if (!run) throw new Error("missing run");
    run.status = "idle";
    run.idleSince = "2026-09-11T00:00:00.000Z" as IsoTime;
    const reasons = deriveAttention({
      now,
      previous: f.state.task.attention,
      stage: "ci",
      blocked: null,
      failed: null,
      budgetMinutes: null,
      activeElapsedMs: 0,
      runs: [run],
      questions: [],
      messages: [],
      stallAfterMs: f.state.config.stallAfterMs,
      fixRoundStallAfterMs: f.state.config.fixRoundStallAfterMs,
      unknownGraceMs: f.state.config.unknownGraceMs,
    }).attention.reasons;
    expect(reasons).not.toContain("idle_without_submission");
  });

  it("migrates a legacy in-progress gate and follows the same green edge", () => {
    const f = fixture("in_progress");
    f.state.ciGate = { headSha: head, since: now };
    const r = fixed(f.state, { ...f.observations, ci: ci("success") });
    expect(r.next.task.stage).toBe("in_review");
    expect(r.transitions.map((transition) => transition.to)).toEqual([
      "ci",
      "in_review",
    ]);
  });

  it("caches changed CI data but an identical poll causes no version bump", () => {
    const { next, obs } = submitted();
    const first = fixed(next, { ...obs, ci: ci("pending") });
    const version = first.next.task.version;
    const second = reconcile(first.next, { ...obs, ci: ci("pending") });
    expect(first.next.ciGate?.ci?.checks[0]?.name).toBe("lint-typecheck-test");
    expect(second.next.task.version).toBe(version);
    expect(second.transitions).toEqual([]);
  });

  it("keeps a failed CI task and its gate in place", () => {
    const { next, obs } = submitted();
    next.task.failed = {
      reason: "action_failed",
      since: now,
      detail: "Push failed",
      runId: null,
    };
    const r = reconcile(next, { ...obs, ci: ci("failure") });
    expect(r.next.task.stage).toBe("ci");
    expect(r.next.ciGate).not.toBeNull();
  });
});

it("an implementer waiting on CI owes no work, so a restart sends it no continuation", () => {
  expect(roleOwesWork("in_progress", "implementer", false, false)).toBe(true);
  expect(roleOwesWork("ci", "implementer", false, false)).toBe(false);
  expect(roleOwesWork("in_review", "reviewer", false, false)).toBe(true);
});

describe("the reviewer is a checker", () => {
  const review = () => {
    const f = fixture("in_review");
    f.state.review = {
      headSha: head,
      lastReviewedHead: null,
      previousBlocking: null,
      verdictIds: [],
    };
    return f;
  };

  it("refuses reviewer commits", () => {
    const f = review();
    const call = reviewCall();
    if (call.tool !== "submit_review") throw new Error("unexpected call");
    call.input.reviewerCommits = ["c".repeat(40) as Sha];
    call.input.reviewedSha = "c".repeat(40) as Sha;
    f.observations.inputs = [mcp(call, "reviewer")];
    const r = reconcile(f.state, f.observations);
    expect(r.inputs[0]?.accepted).toBe(false);
    expect(JSON.stringify(r.inputs[0])).toContain("Reviewers don't commit");
    expect(r.next.task.stage).toBe("in_review");
  });

  it("refuses findings the reviewer claims to have fixed", () => {
    const f = review();
    const call = reviewCall();
    if (call.tool !== "submit_review") throw new Error("unexpected call");
    call.input.findings = [
      {
        severity: "minor",
        status: "fixed",
        commitSha: head,
        title: "Typo",
        body: "Fixed a typo",
        location: null,
      },
    ];
    call.drafts = [{ id: "f9" as never, anchor: null }];
    f.observations.inputs = [mcp(call, "reviewer")];
    const r = reconcile(f.state, f.observations);
    expect(r.inputs[0]?.accepted).toBe(false);
    expect(JSON.stringify(r.inputs[0])).toContain("Reviewers don't fix");
  });

  it("a blocking finding requests a fresh implementer round", () => {
    const f = review();
    f.observations.inputs = [mcp(reviewCall([finding("f1")]), "reviewer")];
    const r = fixed(f.state, f.observations);
    expect(r.inputs[0]?.accepted).toBe(true);
    expect(r.next.task.stage).toBe("in_progress");
    expect(r.next.messages.some((m) => m.purpose === "fix_round")).toBe(false);
    expect(r.next.desiredRun).toMatchObject({
      role: "implementer",
      round: 1,
      resume: false,
      retireRunId: "t1/implementer/0",
      fixReason: expect.stringContaining("Review round"),
    });
  });
});
