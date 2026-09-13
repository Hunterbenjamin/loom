import { randomUUID } from "node:crypto";
import type {
  FindingAnchor,
  FindingLocationInput,
  GetTaskContextOutput,
  Input,
  InputDisposition,
  McpCall,
  McpError,
  McpResult,
  McpToolName,
  RunId,
  Sha,
} from "@loom/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type LeadHost, leadInputSchemas, leadToolNames } from "./lead.js";
import {
  anchorSchema,
  errorSchema,
  findingIdSchema,
  inputIdSchema,
  inputSchemas,
  outputSchemas,
  questionIdSchema,
  resultSchema,
  runIdSchema,
  timeSchema,
} from "./schemas.js";

export type McpIdentity =
  | { runId: RunId; active: boolean; kind?: "run" }
  | { kind: "lead"; active: boolean; repoId: string };

export type McpInput = Extract<Input, { type: "mcp" }>;
export interface McpHost {
  /** Persist the input, serialize a reconcile pass for its task, commit, then return its disposition. */
  submit(input: McpInput): Promise<InputDisposition>;
  /** Read the current, role-filtered context without writing an inbox record. */
  context(runId: RunId): GetTaskContextOutput | Promise<GetTaskContextOutput>;
}
export interface McpServerOptions {
  host: McpHost;
  /** Receives the cause of a host failure that the agent only sees as a generic error. */
  log?: (message: string) => void;
  leadHost?: LeadHost;
  /** Re-read authoritative liveness on every call; null means an unknown token. */
  resolveToken(token: string): McpIdentity | null | Promise<McpIdentity | null>;
  /** Read the exact reviewed blobs, verifying the path and range; never read the working file. */
  buildAnchor(input: {
    runId: RunId;
    reviewedSha: Sha;
    location: FindingLocationInput;
  }): Promise<FindingAnchor>;
}
export class McpGuardError extends Error {
  constructor(readonly details: string[]) {
    super("Review location could not be anchored");
  }
}
const failure = (
  code: McpError["code"],
  message: string,
  details: string[] = [message],
): McpResult<never> => ({ ok: false, error: { code, message, details } });
const names = Object.keys(inputSchemas) as McpToolName[];
const descriptions: Record<McpToolName, string> = {
  get_task_context:
    "Read this run's task, plan, findings and workflow commands.",
  submit_plan: "Submit the planner's structured plan for code validation.",
  report_progress: "Record progress, decisions and test results.",
  ask_human:
    "Ask a question; the answer arrives later as a message. End the turn if blocking.",
  submit_for_review: "Submit a clean, committed implementation for review.",
  submit_review: "Submit review findings and verdicts for the reviewed commit.",
  resolve_finding:
    "Mark an open finding fixed or disputed for reviewer verification.",
};

async function invoke(
  options: McpServerOptions,
  token: string,
  name: McpToolName,
  raw: unknown,
): Promise<McpResult<unknown>> {
  const parsed = inputSchemas[name].safeParse(raw);
  if (!parsed.success)
    return failure(
      "invalid_input",
      "Tool input failed validation",
      parsed.error.issues.map(
        (i) => `${i.path.join(".") || "input"}: ${i.message}`,
      ),
    );
  const identity = token ? await options.resolveToken(token) : null;
  if (!identity)
    return failure("unknown_run", "The token does not identify a run");
  if (identity.kind === "lead")
    return failure("guard_failed", "Main identity cannot call task-run tools");
  if (!identity.active)
    return failure("stale_run", "The run has ended or was superseded");
  const runId = runIdSchema.parse(identity.runId);
  if (name === "get_task_context")
    return {
      ok: true,
      value: outputSchemas.get_task_context.parse(
        await options.host.context(runId),
      ),
    };
  // Re-parse in each enriched branch to preserve the discriminated core contract.
  let call: McpCall;
  if (name === "ask_human") {
    call = {
      tool: name,
      input: inputSchemas.ask_human.parse(raw),
      questionId: questionIdSchema.parse(randomUUID()),
    };
  } else if (name === "submit_review") {
    const input = inputSchemas.submit_review.parse(raw);
    const drafts: Extract<McpCall, { tool: "submit_review" }>["drafts"] = [];
    const failures: string[] = [];
    for (const [index, finding] of input.findings.entries()) {
      let anchor: FindingAnchor | null = null;
      if (finding.location) {
        try {
          anchor = anchorSchema.parse(
            await options.buildAnchor({
              runId,
              reviewedSha: input.reviewedSha,
              location: finding.location,
            }),
          );
          const loc = finding.location;
          if (
            anchor.headSha !== input.reviewedSha ||
            anchor.side !== loc.side ||
            anchor.startLine !== loc.startLine ||
            anchor.endLine !== loc.endLine ||
            (loc.side === "new" ? anchor.newPath : anchor.oldPath) !==
              loc.path ||
            !(loc.side === "new" ? anchor.newBlobOid : anchor.oldBlobOid)
          ) {
            failures.push(
              `Finding ${index}: anchor must match the reviewed commit, path, side and range`,
            );
          }
        } catch (error) {
          if (!(error instanceof McpGuardError)) throw error;
          failures.push(
            ...error.details.map((detail) => `Finding ${index}: ${detail}`),
          );
        }
      }
      drafts.push({ id: findingIdSchema.parse(randomUUID()), anchor });
    }
    if (failures.length)
      return failure(
        "guard_failed",
        "Review locations failed validation",
        failures,
      );
    call = { tool: name, input, drafts };
  } else {
    // This mapping is checked per tool by the schema equality tests.
    call = { tool: name, input: parsed.data } as McpCall;
  }
  const input: McpInput = {
    id: inputIdSchema.parse(randomUUID()),
    type: "mcp",
    receivedAt: timeSchema.parse(new Date().toISOString()),
    runId,
    call,
  };
  const disposition = await options.host.submit(input);
  if (disposition.inputId !== input.id)
    throw new Error("Host returned a different input's disposition");
  if (!disposition.accepted)
    return { ok: false, error: errorSchema.parse(disposition.error) };
  if (!disposition.reply || disposition.reply.tool !== name)
    throw new Error("Host returned a mismatched reply");
  return {
    ok: true,
    value: outputSchemas[name].parse(disposition.reply.value),
  };
}

/** One server per transport connection. Identity is bound outside tool arguments. */
export function createMcpServer(
  options: McpServerOptions,
  token: string,
): Server {
  const server = new Server(
    { name: "loom", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const identity = token ? await options.resolveToken(token) : null;
    if (identity?.kind === "lead")
      return {
        tools: leadToolNames.map((name) => ({
          name,
          description:
            name === "message_agent"
              ? "Queue a short question or heads-up through Loom, always recorded. Returns queued/refused without waiting for a reply. Use idempotencyKey for retries; create an issue for work."
              : name === "set_note"
                ? "Replace Main's instance memory note (max 2000 characters); empty clears it."
                : `Main: ${name.replaceAll("_", " ")}. Uses Loom's human commands and guards.`,
          inputSchema: z.toJSONSchema(leadInputSchemas[name] as z.ZodObject, {
            io: "input",
          }) as { type: "object" },
          annotations: {
            readOnlyHint: ["list_tasks", "inspect_task", "list_repos"].includes(
              name,
            ),
            destructiveHint: false,
            openWorldHint: false,
          },
        })),
      };
    return {
      tools: names.map((name) => ({
        name,
        description: descriptions[name],
        inputSchema: z.toJSONSchema(inputSchemas[name], { io: "input" }) as {
          type: "object";
        },
        outputSchema: {
          ...z.toJSONSchema(resultSchema(outputSchemas[name]), { io: "input" }),
          type: "object" as const,
        },
        annotations: {
          readOnlyHint: name === "get_task_context",
          destructiveHint: false,
          openWorldHint: false,
        },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (leadToolNames.includes(name)) {
      const identity = token ? await options.resolveToken(token) : null;
      if (!identity) return reply(failure("unknown_run", "Unknown identity"));
      if (identity.kind !== "lead")
        return reply(
          failure("guard_failed", "Task-run identity cannot call Main tools"),
        );
      if (!identity.active)
        return reply(failure("stale_run", "Main session stopped"));
      const parsed = (leadInputSchemas[name] as z.ZodObject).safeParse(
        request.params.arguments ?? {},
      );
      if (!parsed.success)
        return reply(failure("invalid_input", "Tool input failed validation"));
      try {
        if (!options.leadHost) throw new Error("Main unavailable");
        return reply({
          ok: true,
          value: await options.leadHost.invoke(
            name,
            parsed.data,
            identity.repoId,
          ),
        });
      } catch (error) {
        options.log?.(
          `Main tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new Error("Loom host could not complete the request");
      }
    }
    if (!names.includes(name as McpToolName))
      return reply(failure("invalid_input", "Unknown Loom tool"));
    try {
      return reply(
        await invoke(
          options,
          token,
          name as McpToolName,
          request.params.arguments ?? {},
        ),
      );
    } catch (error) {
      // Do not echo host errors: they may contain tokens, paths or provider payloads. The
      // coordinator's own log gets the cause, so a refused call at launch is diagnosable.
      options.log?.(
        `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error("Loom host could not complete the request");
    }
  });
  return server;
}
function reply(result: McpResult<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
    isError: !result.ok,
  };
}
