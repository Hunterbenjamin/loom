import type { Context } from "./context.js";
import type { Task } from "./entities.js";
import type { Sha } from "./ids.js";
import type { TestResultInput } from "./mcp.js";
import type { TaskState } from "./reconcile.js";

/** Latest implementer submission, independent of role-to-role handoffs. */
export interface Implementation {
  headSha: Sha;
  summary: string;
  decisions: string[];
  testResults: TestResultInput[];
}

export function latestImplementation(state: TaskState): Implementation | null {
  return (
    (state.artifactContents.implementation as Implementation | undefined) ??
    null
  );
}

export function whatChanged(implementation: Implementation): string {
  return [
    implementation.summary,
    ...(implementation.decisions.length
      ? [
          "### Deviations and decisions",
          ...implementation.decisions.map((decision) => `- ${decision}`),
        ]
      : []),
  ].join("\n\n");
}

export function implementationBody(
  task: Task,
  implementation: Implementation | null,
): string {
  return [
    "## Description",
    task.description,
    "## What changed",
    implementation
      ? whatChanged(implementation)
      : "No implementation submission recorded.",
    `Issue: [${task.id}](loom://issue/${encodeURIComponent(task.id)})`,
    "## Tests",
    implementation?.testResults.length
      ? implementation.testResults
          .map(
            (test) => `- ${test.outcome}: ${test.command} — ${test.summary}`,
          )
          .join("\n")
      : "No test results reported for this submission.",
  ].join("\n\n");
}

/** Reconcile once per submission/body, after the submitted head reaches GitHub. */
export function publishImplementation(c: Context): void {
  const implementation = latestImplementation(c.state);
  const version = c.state.artifacts.find(
    (artifact) => artifact.kind === "implementation",
  )?.version;
  if (
    !implementation ||
    !version ||
    !c.task.branch ||
    c.pr?.state !== "open" ||
    c.pr.headSha !== implementation.headSha ||
    ["done", "canceled"].includes(c.task.stage)
  )
    return;
  const body = implementationBody(c.task, implementation);
  c.emit(
    `update_pr_body:${c.task.id}:${c.pr.number}:${version}:${c.state.config.sha256(body)}`,
    {
      kind: "update_pr_body",
      repoId: c.task.repoId,
      prNumber: c.pr.number,
      branch: c.task.branch,
      expectedHeadSha: implementation.headSha,
      implementationVersion: version,
      body,
    },
  );
}
