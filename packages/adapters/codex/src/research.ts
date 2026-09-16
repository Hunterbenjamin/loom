import { setTimeout as delay } from "node:timers/promises";
import type { ResearchSessionRequest } from "@loom/protocol";
import { researchDocument } from "@loom/protocol";
import { z } from "zod";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { RpcConnection } from "./protocol.js";
import {
  metadataResult,
  threadTokenUsageUpdated,
  turnResult,
} from "./schemas.js";

export const researchConfig = {
  web_search: "live",
  mcp_servers: {},
  project_doc_max_bytes: 0,
  features: {
    shell_tool: false,
    unified_exec: false,
    view_image: false,
    multi_agent: false,
    multi_agent_v2: false,
    js_repl: false,
    apps: false,
    plugins: false,
    tool_suggest: false,
  },
};
/** OpenAI's structured outputs accept only a fixed set of string formats (date-time, date, time,
 * duration, email, hostname, ipv4, ipv6, uuid), so a schema carrying `format: "uri"` is refused
 * with `invalid_json_schema`. Drop the unsupported formats here, where that provider limit lives;
 * the returned document is still parsed against the zod schema, which validates the URL itself. */
/** How long a fresh thread may fail to read before the failure counts as real. */
const THREAD_STORE_READY_MS = 10_000;

const OPENAI_STRING_FORMATS = new Set([
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);
export function codexOutputSchema(schema: z.ZodType) {
  return z.json().parse(
    z.toJSONSchema(schema, {
      override: ({ jsonSchema }) => {
        if (
          typeof jsonSchema.format === "string" &&
          !OPENAI_STRING_FORMATS.has(jsonSchema.format)
        )
          delete jsonSchema.format;
      },
    }),
  );
}

const researchThread = z.object({
  thread: z.object({
    turns: z.array(
      z.object({
        id: z.string(),
        status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
        error: z.object({ message: z.string() }).nullable(),
        items: z.array(
          z.object({ type: z.string(), text: z.string().optional() }),
        ),
      }),
    ),
  }),
});

/** Uses the existing app-server transport, with no coding environment or inherited tool servers. */
export async function runCodexResearch(
  connection: RpcConnection,
  request: ResearchSessionRequest,
  observe: (listener: (method: string, params: unknown) => void) => () => void,
) {
  request.controller.signal.throwIfAborted();
  const start: ThreadStartParams = {
    cwd: request.cwd,
    model: request.model,
    sandbox: "read-only",
    approvalPolicy: "never",
    environments: [],
    runtimeWorkspaceRoots: [],
    selectedCapabilityRoots: [],
    config: researchConfig,
    developerInstructions: request.prompt,
    ephemeral: false,
    historyMode: "legacy",
    allowProviderModelFallback: false,
    experimentalRawEvents: true,
  };
  const { thread } = await connection.rpc(
    "thread/start",
    start,
    metadataResult,
  );
  request.onSession(thread.id);
  let webSucceeded = false;
  let steps = 0;
  let limitError: string | null = null;
  const webIds = new Set<string>();
  const unobserve = observe((method, params) => {
    if (method === "thread/tokenUsage/updated") {
      const update = threadTokenUsageUpdated.parse(params);
      if (
        update.threadId === thread.id &&
        update.tokenUsage.total.totalTokens > request.limits.tokens
      )
        limitError = "Research token ceiling exceeded";
    }
    // Raw completed Responses items carry success status; item/started is not lookup evidence.
    if (method === "rawResponseItem/completed") {
      const event = z
        .object({
          threadId: z.string(),
          item: z.object({
            type: z.string(),
            id: z.string().optional(),
            status: z.string().optional(),
          }),
        })
        .parse(params);
      if (event.threadId !== thread.id || event.item.type !== "web_search_call")
        return;
      if (event.item.status === "completed") webSucceeded = true;
      if (!event.item.id || !webIds.has(event.item.id)) {
        if (event.item.id) webIds.add(event.item.id);
        steps += 1;
        if (steps > request.limits.turns)
          limitError = "Research web lookup limit exceeded";
      }
    }
  });
  let turnId: string | null = null;
  let completed = false;
  try {
    request.controller.signal.throwIfAborted();
    const params: TurnStartParams = {
      threadId: thread.id,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      environments: [],
      runtimeWorkspaceRoots: [],
      model: request.model,
      effort: request.reasoningEffort,
      outputSchema: codexOutputSchema(researchDocument),
    };
    const result = await connection.rpc("turn/start", params, turnResult);
    turnId = result.turn.id;
    let readable = false;
    const readableBy = Date.now() + THREAD_STORE_READY_MS;
    while (true) {
      request.controller.signal.throwIfAborted();
      if (limitError) throw new Error(limitError);
      let read: z.infer<typeof researchThread>;
      try {
        read = await connection.rpc(
          "thread/read",
          { threadId: thread.id, includeTurns: true },
          researchThread,
        );
        readable = true;
      } catch (error) {
        // The app-server writes the thread's rollout file after turn/start returns, so a read
        // issued before that lands fails with "rollout ... is empty" while the turn is running
        // normally. Treat that as not-yet-readable until the store serves its first read; a
        // failure after that is real and stops the run.
        if (readable || Date.now() > readableBy) throw error;
        await delay(250, undefined, { signal: request.controller.signal });
        continue;
      }
      const turn = read.thread.turns.find((item) => item.id === turnId);
      if (limitError) throw new Error(limitError);
      if (turn && turn.status !== "inProgress") {
        completed = true;
        const text =
          turn.items.filter((item) => item.type === "agentMessage").at(-1)
            ?.text ?? "";
        if (turn.status !== "completed")
          throw new Error(
            `Research ${turn.status}: ${turn.error?.message ?? ""}\n${text}`,
          );
        if (!webSucceeded)
          throw new Error(
            `Research returned without a successful live web lookup\n${text}`,
          );
        if (text.length > 115000)
          throw new Error("Research output exceeds document size limit");
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new Error(
            `Research returned prose instead of a structured document:\n${text}`,
          );
        }
        const parsed = researchDocument.safeParse(value);
        if (!parsed.success)
          throw new Error(
            `Invalid structured research document: ${parsed.error.message}\nProvider output: ${text}`,
          );
        return parsed.data;
      }
      await delay(250, undefined, { signal: request.controller.signal });
    }
  } finally {
    unobserve();
    // Leaving without a finished turn leaves the model running and billing against the account,
    // so interrupt on every early exit, not only on abort and the lookup ceiling. The turn often
    // ends on its own first ("no active turn to interrupt"), and that must never replace the
    // error that actually ended the research.
    if (turnId && !completed)
      await connection
        .rpc("turn/interrupt", { threadId: thread.id, turnId }, z.object({}))
        .catch(() => {});
  }
}
