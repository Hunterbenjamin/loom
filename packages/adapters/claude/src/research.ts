import { query } from "@anthropic-ai/claude-agent-sdk";
import { type BriefContent, briefContent } from "@loom/protocol";
import { z } from "zod";

/** A separate, bounded web-only session; never grants access to the user's coding workspace. */
export function createBriefResearch(executable: string): BriefResearch {
  return async (request) => {
    const stream = query({
      prompt: request.prompt,
      options: {
        cwd: request.cwd,
        sessionId: request.sessionId,
        model: request.model,
        pathToClaudeCodeExecutable: executable,
        abortController: request.controller,
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        tools: ["WebSearch", "WebFetch"],
        allowedTools: ["WebSearch", "WebFetch"],
        permissionMode: "dontAsk",
        maxTurns: 30,
        maxBudgetUsd: 3,
        outputFormat: {
          type: "json_schema",
          // Claude Code validates draft-7 and rejects Zod's default 2020-12 schema.
          schema: z.toJSONSchema(briefContent, { target: "draft-7" }),
        },
      },
    });
    const webCalls = new Set<string>();
    let webSucceeded = false;
    try {
      for await (const message of stream) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (
              block.type === "tool_use" &&
              ["WebSearch", "WebFetch"].includes(block.name)
            )
              webCalls.add(block.id);
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (
              block.type === "tool_result" &&
              webCalls.has(block.tool_use_id) &&
              !block.is_error
            )
              webSucceeded = true;
          }
        }
        if (message.type === "result") {
          if (message.subtype !== "success")
            throw new Error(`Research did not complete: ${message.subtype}`);
          if (!webSucceeded)
            throw new Error(
              "Research returned without a successful live web lookup",
            );
          return briefContent.parse(message.structured_output);
        }
      }
      throw new Error("Research ended without a completed result");
    } finally {
      stream.close();
    }
  };
}

export interface ResearchRequest {
  sessionId: string;
  cwd: string;
  model: string;
  prompt: string;
  controller: AbortController;
}
export type BriefResearch = (request: ResearchRequest) => Promise<BriefContent>;
