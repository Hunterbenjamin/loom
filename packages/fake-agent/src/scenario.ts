import { readFile } from "node:fs/promises";
import type { McpToolName } from "@loom/core";
import {
  PROVIDER_VALUES,
  ROLE_VALUES,
  RUN_MODE_VALUES,
  TURN_OUTCOME_VALUES,
} from "@loom/core";
import { errorSchema, inputSchemas } from "@loom/mcp";
import { z } from "zod";

const milliseconds = z.number().int().nonnegative();
const files = z.record(z.string().min(1), z.string());
const pattern = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid message regular expression");
export const stepSchema = z.union([
  z.strictObject({
    expect: z.literal("message"),
    match: pattern.optional(),
    timeoutMs: milliseconds.optional(),
  }),
  z.strictObject({ status: z.enum(["working", "idle"]) }),
  z.strictObject({
    request: z.enum(["approval", "question"]),
    summary: z.string(),
    expect: z.enum(["accept", "decline", "answer"]),
  }),
  z.strictObject({
    tool: z.enum(Object.keys(inputSchemas) as [McpToolName, ...McpToolName[]]),
    input: z.unknown().refine((v) => v !== undefined, "Input is required"),
    expectError: errorSchema.shape.code.optional(),
  }),
  z.strictObject({
    git: z.enum(["commit", "write"]),
    files,
    message: z.string(),
  }),
  z.strictObject({
    turn: z.enum([...TURN_OUTCOME_VALUES]),
    error: z
      .strictObject({ willRetry: z.boolean(), kind: z.string() })
      .optional(),
  }),
  z.strictObject({ rateLimit: z.strictObject({ resetsInMs: milliseconds }) }),
  z.strictObject({ crash: z.literal(true) }),
  z.strictObject({ stall: milliseconds }),
  z.strictObject({ dropDelivery: z.literal(true) }),
  z.strictObject({ duplicate: z.literal("last_event") }),
  z.strictObject({
    github: z.literal("ci"),
    conclusion: z.enum(["success", "failure", "pending"]),
  }),
  z.strictObject({ github: z.literal("push"), files }),
  z.strictObject({
    github: z.literal("comment"),
    body: z.string(),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    changesRequested: z.boolean().optional(),
  }),
  z.strictObject({ github: z.enum(["merge", "close"]) }),
]);
export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  agent: z.strictObject({
    provider: z.enum([...PROVIDER_VALUES]),
    role: z.enum([...ROLE_VALUES]),
    mode: z.enum([...RUN_MODE_VALUES]),
    attempt: z.number().int().positive().optional(),
  }),
  steps: z.array(stepSchema),
});
export const scenarioSetSchema = z.array(scenarioSchema).min(1);
export type Step = z.infer<typeof stepSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export const parseScenarios = (input: unknown): Scenario[] =>
  scenarioSetSchema.parse(input);
export async function loadScenarios(path: string | URL): Promise<Scenario[]> {
  return parseScenarios(JSON.parse(await readFile(path, "utf8")));
}

/** Zero-based IDs in creation order. Unknown placeholders fail rather than reaching MCP. */
export function substitute(
  input: unknown,
  values: {
    head: string | null;
    findings: readonly string[];
    questions: readonly string[];
  },
): unknown {
  if (typeof input === "string")
    return input.replace(
      /\$HEAD\b|\$(FINDING|QUESTION)_(\d+)\b/g,
      (token, kind: string | undefined, index: string | undefined) => {
        const value = kind
          ? (kind === "FINDING" ? values.findings : values.questions)[
              Number(index)
            ]
          : values.head;
        if (value == null)
          throw new Error(`Unresolved scenario placeholder ${token}`);
        return value;
      },
    );
  if (Array.isArray(input)) return input.map((v) => substitute(v, values));
  if (input && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, substitute(v, values)]),
    );
  return input;
}
