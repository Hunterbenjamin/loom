import { expect, test } from "vitest";
import {
  fixed,
  fixture,
  type head,
  mcp,
  reviewCall,
  submit,
} from "../test/fixtures.js";
import { Context } from "./context.js";
import {
  implementationBody,
  latestImplementation,
  publishImplementation,
  whatChanged,
} from "./implementation.js";
import { submission } from "./submissions.js";

function submitted() {
  const f = fixture("in_progress");
  const call = submit();
  if (call.tool !== "submit_for_review") throw new Error("fixture");
  call.input.summary = "Added the requested behavior.";
  call.input.handoff.summary = "Review the branch.";
  call.input.testResults = [
    {
      command: "pnpm test feature.test.ts",
      outcome: "passed",
      summary: "3 passed",
    },
  ];
  f.state.artifactContents.decisions = [
    "Used the existing layout to avoid a second owner.",
  ];
  const c = new Context(f.state, f.observations);
  const input = mcp(call);
  if (input.type !== "mcp") throw new Error("fixture");
  expect(submission(c, input)).not.toHaveProperty("code");
  return { ...f, c, call, input };
}

test("submission keeps request intact and replaces implementation independently of handoff", () => {
  const { c, call, input } = submitted();
  const request = c.task.description;
  const first = latestImplementation(c.state);
  if (!first) throw new Error("Missing implementation");
  expect(first.summary).toBe(call.input.summary);
  expect(implementationBody(c.task, first, c.state.issueKey)).toContain(
    whatChanged(first),
  );
  expect(implementationBody(c.task, first, c.state.issueKey)).toContain(
    "3 passed",
  );
  expect(implementationBody(c.task, first, c.state.issueKey)).toContain(
    "Issue: LOOM-1",
  );
  c.artifact("handoff", { from: "reviewer", summary: "Checked round one" });
  expect(latestImplementation(c.state)).toEqual(first);
  c.task.stage = "in_progress";
  call.input.summary = "Complete behavior including the fix.";
  call.input.testResults = [];
  expect(submission(c, input)).not.toHaveProperty("code");
  expect(c.task.description).toBe(request);
  expect(latestImplementation(c.state)?.summary).toBe(call.input.summary);
  expect(
    implementationBody(c.task, latestImplementation(c.state), c.state.issueKey),
  ).not.toContain("3 passed");
  expect(
    c.state.artifacts.find((a) => a.kind === "implementation")?.version,
  ).toBe(2);
});

test("first PR body uses implementation content even after reviewer replaces the handoff", () => {
  const { c } = submitted();
  const f = fixture("in_review");
  f.state.artifacts = c.state.artifacts;
  f.state.artifactContents = c.state.artifactContents;
  f.state.task.description = "Human request";
  f.state.task.prNumber = null;
  f.observations.github = { ok: true, at: f.observations.now, value: null };
  f.observations.inputs = [mcp(reviewCall(), "reviewer")];
  const result = fixed(f.state, f.observations);
  const action = result.actions.find((a) => a.kind === "open_pr");
  expect(action).toMatchObject({
    body: implementationBody(
      f.state.task,
      latestImplementation(c.state),
      f.state.issueKey,
    ),
  });
  expect(result.next.artifactContents.handoff).toMatchObject({
    from: "reviewer",
  });
  expect(latestImplementation(result.next)?.summary).toBe(
    "Added the requested behavior.",
  );
});

test("existing PR body intents are idempotent, replaced on fix submissions, and require the submitted remote head", () => {
  const { c, call, input } = submitted();
  publishImplementation(c);
  const updates = () =>
    c.state.outbox.filter((a) => a.kind === "update_pr_body");
  expect(updates()).toHaveLength(1);
  publishImplementation(c);
  expect(updates()).toHaveLength(1);
  c.task.stage = "in_progress";
  call.input.summary = "Fix round replaces the complete description.";
  submission(c, input);
  publishImplementation(c);
  expect(updates()).toHaveLength(2);
  const pr = c.observations.github;
  if (!pr?.ok || !pr.value) throw new Error("fixture");
  pr.value.headSha = "b".repeat(40) as typeof head;
  c.artifact("implementation", {
    ...latestImplementation(c.state),
    summary: "third",
  });
  publishImplementation(c);
  expect(updates()).toHaveLength(2);
});
