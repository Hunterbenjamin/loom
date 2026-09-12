import { createHash } from "node:crypto";
import type { GetTaskContextOutput, Role, Stage, TaskState } from "@loom/core";
import { fixture, head } from "../../core/test/fixtures.js";
import { InMemoryHost } from "./memory.js";
import { anchorSchema } from "./schemas.js";
import { McpGuardError, type McpServerOptions } from "./server.js";

export function setup(
  stage: Stage = "in_progress",
  role: Role = "implementer",
) {
  const { state, observations } = fixture(stage);
  state.task.reviewRound = stage === "in_review" ? 1 : 0;
  state.runs = state.runs.filter((r) => r.role === role);
  const run = state.runs[0];
  if (!run) throw new Error("Missing test run");
  const host = new InMemoryHost(state, observations, (s, id) => context(s, id));
  const token = "fixture-run-token";
  host.tokens.set(token, run.id);
  const options: McpServerOptions = {
    host,
    resolveToken: host.resolveToken,
    buildAnchor: async ({ reviewedSha, location }) => {
      // A tiny immutable blob fixture. Never reads a working-tree file.
      if (
        reviewedSha !== head ||
        location.path !== "src/example.ts" ||
        location.endLine > 2
      )
        throw new McpGuardError([
          "Path or range does not exist in the reviewed blob",
        ]);
      const lines = ["export const example = 1;", "export const other = 2;"];
      const hash = (s: string) => createHash("sha256").update(s).digest("hex");
      const selectedText = lines
        .slice(location.startLine - 1, location.endLine)
        .join("\n");
      return anchorSchema.parse({
        baseSha: state.worktree?.baseSha,
        headSha: reviewedSha,
        oldPath: location.path,
        newPath: location.path,
        oldBlobOid: "c".repeat(40),
        newBlobOid: "d".repeat(40),
        side: location.side,
        startLine: location.startLine,
        endLine: location.endLine,
        startColumn: null,
        endColumn: null,
        selectedText,
        selectedTextHash: hash(selectedText),
        contextBeforeHash: hash(
          lines.slice(0, location.startLine - 1).join("\n"),
        ),
        contextAfterHash: hash(lines.slice(location.endLine).join("\n")),
        normalization: "lf-v1",
      });
    },
  };
  return { host, options, token, run };
}
function context(
  state: TaskState,
  id: GetTaskContextOutput["run"]["id"],
): GetTaskContextOutput {
  const run = state.runs.find((r) => r.id === id);
  const worktree = state.worktree;
  if (!run || !worktree) throw new Error("Missing context");
  const plan = state.plan;
  return {
    task: {
      id: state.task.id,
      title: state.task.title,
      description: state.task.description,
      stage: state.task.stage,
      reviewRound: state.task.reviewRound,
      reviewRoundCap: state.task.reviewRoundCap,
    },
    role: run.role,
    run: { id: run.id, round: run.round, attempts: run.attempts },
    worktree: {
      path: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseSha: worktree.baseSha,
      headSha: head,
    },
    brief: "Implement the MCP boundary",
    plan: plan
      ? {
          goal: plan.goal,
          nonGoals: plan.nonGoals,
          steps: plan.steps,
          areas: plan.areas,
          acceptanceCriteria: plan.acceptanceCriteria,
          testPlan: plan.testPlan,
          risks: plan.risks,
          openQuestions: plan.openQuestions,
          suggestedImplementer: plan.suggestedImplementer,
          version: plan.version,
        }
      : null,
    decisions: "",
    handoff: null,
    findings: [],
    testResults: [],
    answeredQuestions: [],
    workflow: { test: "pnpm test" },
  };
}
