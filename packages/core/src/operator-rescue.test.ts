import { expect, test } from "vitest";
import { fixture, head, now, run } from "../test/fixtures.js";
import { Context } from "./context.js";
import { human } from "./human.js";

function rescue() {
  const f = fixture("in_progress");
  f.state.review = null;
  f.state.task.prNumber = null;
  f.state.runs = [{ ...run(), endedAt: now, endReason: "vanished" }];
  if (!f.observations.git?.ok) throw new Error("git");
  Object.assign(f.observations.git.value, {
    headSha: head,
    dirty: false,
    aheadOfBase: 1,
    remoteHeadSha: null,
  });
  return f;
}
test("rescue guards clean HEAD and push ordering without submitting or advancing", () => {
  const f = rescue();
  const c = new Context(f.state, f.observations);
  expect(human(c, { type: "open_pr", headSha: head }, "input")).toMatchObject({
    code: "guard_failed",
  });
  expect(human(c, { type: "push_branch", headSha: head }, "input")).toBeNull();
  expect(c.result.actions).toMatchObject([
    { kind: "push_branch", expectedHeadSha: head },
  ]);
  expect(c.task.stage).toBe("in_progress");
  expect(c.state.review).toBeNull();
  if (!f.observations.git?.ok) throw new Error("git");
  f.observations.git.value.remoteHeadSha = head;
  expect(human(c, { type: "open_pr", headSha: head }, "input2")).toBeNull();
  expect(c.result.actions[1]).toMatchObject({
    kind: "open_pr",
    rescueHeadSha: head,
  });
  expect(c.task.stage).toBe("in_progress");
});
test.each(["dirty", "changed", "live", "submitted", "canceled"])(
  "rescue refuses %s owner state",
  (kind) => {
    const f = rescue();
    if (!f.observations.git?.ok) throw new Error("git");
    if (kind === "dirty") f.observations.git.value.dirty = true;
    if (kind === "changed") f.observations.git.value.headSha = null;
    if (kind === "live") f.state.runs.push(run("reviewer"));
    if (kind === "submitted" && f.state.runs[0])
      f.state.runs[0].endReason = "submitted";
    if (kind === "canceled") f.state.task.stage = "canceled";
    const c = new Context(f.state, f.observations);
    expect(
      human(c, { type: "push_branch", headSha: head }, "input"),
    ).not.toBeNull();
    expect(c.result.actions).toEqual([]);
  },
);
