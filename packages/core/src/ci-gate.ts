import type { Context } from "./context.js";
import type { CiState } from "./entities.js";
import type { FindingId } from "./ids.js";

/**
 * A repository without CI never reports a check. Once the gate's push has succeeded and GitHub has
 * shown no check for this long, review starts rather than waiting forever.
 */
export const CI_START_GRACE_MS = 5 * 60_000;

const failedChecks = (ci: CiState) =>
  ci.checks.filter(
    (check) =>
      check.status === "completed" &&
      check.conclusion !== null &&
      !["success", "neutral", "skipped"].includes(check.conclusion),
  );

/** One blocking finding per failed check run, each recorded once. */
export function ciFindings(c: Context, ci: CiState): void {
  const failed = failedChecks(ci);
  for (const check of failed.length
    ? failed
    : [{ id: `${ci.headSha}:status`, name: "CI", conclusion: "failure" }]) {
    if (
      c.state.findings.some(
        (f) => f.source === "ci" && f.externalId === check.id,
      )
    )
      continue;
    c.finding({
      id: `${c.task.id}/ci/${check.id}` as FindingId,
      source: "ci",
      externalId: check.id,
      severity: "major",
      title: check.name,
      body: `CI failed on ${ci.headSha.slice(0, 7)}: ${check.conclusion}${"url" in check && check.url ? ` (${check.url})` : ""}`,
      anchor: null,
    });
  }
}

/**
 * CI before review (docs/architecture.md, "CI gate"). The implementer's submission is pushed and
 * waits here: green starts a review round, red goes straight back to the same implementer, and the
 * reviewer only ever reads code that already passes the machine checks.
 */
export function reconcileCiGate(c: Context): void {
  const { task, state, git } = c;
  const gate = state.ciGate;
  if (!gate) return;
  if (task.stage !== "in_progress" || task.blocked || task.failed) {
    if (task.stage !== "in_progress") state.ciGate = null;
    return;
  }
  // New commits after submitting withdraw it; the implementer submits the new head.
  if (git?.headSha && git.headSha !== gate.headSha) {
    state.ciGate = null;
    return;
  }
  const reading = c.observations.ci;
  if (!reading?.ok || reading.value.headSha !== gate.headSha) return;
  const ci = reading.value;
  if (ci.conclusion === "pending") return;
  if (ci.conclusion === "none") {
    const pushed = state.outbox.find(
      (row) =>
        row.key === `push_branch:${task.id}:${gate.headSha}` &&
        row.status === "succeeded",
    );
    if (
      !pushed?.finishedAt ||
      Date.parse(c.now) - Date.parse(pushed.finishedAt) < CI_START_GRACE_MS
    )
      return;
  }
  state.ciGate = null;
  if (ci.conclusion === "failure") {
    ciFindings(c, ci);
    c.stage("in_progress", "CI failed on the submitted head");
    c.fix(`ci-gate:${gate.headSha}`);
    return;
  }
  // Green (or no CI at all): earlier CI failures are settled by this commit, not by anyone's say-so.
  for (const finding of state.findings)
    if (
      finding.source === "ci" &&
      finding.status !== "resolved" &&
      finding.status !== "waived"
    ) {
      finding.status = "resolved";
      finding.resolution = {
        by: "ci",
        note:
          ci.conclusion === "none"
            ? `No CI reported for ${gate.headSha}`
            : `CI passed on ${gate.headSha}`,
        commitSha: gate.headSha,
        at: c.now,
      };
      finding.updatedAt = c.now;
    }
  c.stage(
    "in_review",
    ci.conclusion === "none"
      ? "No CI reported; submitted head goes to review"
      : "CI passed on the submitted head",
  );
  c.review(gate.headSha);
}
