import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** The only Claude research runner: a tool allowlist, isolated settings and structured output. */
export async function runWebResearch<T>(
  executable: string,
  request: {
    cwd: string;
    sessionId: string;
    model: string;
    prompt: string;
    controller: AbortController;
    maxTurns: number;
    maxBudgetUsd: number;
  },
  schema: z.ZodType<T>,
): Promise<T> {
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
      maxTurns: request.maxTurns,
      maxBudgetUsd: request.maxBudgetUsd,
      outputFormat: {
        type: "json_schema",
        schema: z.toJSONSchema(schema, { target: "draft-7" }),
      },
    },
  });
  const webCalls = new Set<string>();
  let webSucceeded = false;
  let text = "";
  try {
    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text")
            text = (text + block.text).slice(0, 110000);
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
          throw new Error(
            `Research did not complete: ${message.subtype}\n${text}`,
          );
        if (!webSucceeded)
          throw new Error(
            `Research returned without a successful live web lookup\n${message.result ?? text}`,
          );
        const parsed = schema.safeParse(message.structured_output);
        if (!parsed.success)
          throw new Error(
            `Invalid structured research document: ${parsed.error.message}\nProvider output: ${message.result || text || JSON.stringify(message.structured_output)}`,
          );
        return parsed.data;
      }
    }
    throw new Error(`Research ended without a completed result\n${text}`);
  } finally {
    stream.close();
  }
}
