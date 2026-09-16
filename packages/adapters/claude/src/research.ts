import { type ResearchSession, researchDocument } from "@loom/protocol";
import { runWebResearch } from "./web-research.js";

export function createClaudeResearch(executable: string): ResearchSession {
  return (request) =>
    runWebResearch(
      executable,
      {
        ...request,
        maxTurns: request.limits.turns,
        // Claude's SDK bounds spend, rather than exposing an in-flight token ceiling.
        maxBudgetUsd: request.limits.tokens * 0.00003,
      },
      researchDocument,
    );
}
