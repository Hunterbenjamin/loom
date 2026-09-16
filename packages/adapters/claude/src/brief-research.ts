import { type BriefContent, briefContent } from "@loom/protocol";
import { runWebResearch } from "./web-research.js";

export interface ResearchRequest {
  sessionId: string;
  cwd: string;
  model: string;
  prompt: string;
  controller: AbortController;
}
export type BriefResearch = (request: ResearchRequest) => Promise<BriefContent>;
export function createBriefResearch(executable: string): BriefResearch {
  return (request) =>
    runWebResearch(
      executable,
      { ...request, maxTurns: 30, maxBudgetUsd: 3 },
      briefContent,
    );
}
