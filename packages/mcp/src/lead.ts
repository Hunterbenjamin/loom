// Main retains the internal `lead` identity for persisted sessions and clients.
// Tools reuse the protocol boundary and human command path. No stage rules live here.

import type { Command } from "@loom/protocol";
import { command, humanCommand, repoId, runId, taskId } from "@loom/protocol";
import { z } from "zod";

const humanTypes = {
  push_branch: "push_branch",
  open_pr: "open_pr",
  move_task: "move",
  approve_plan: "approve_plan",
  reject_plan: "reject_plan",
  approve_merge: "approve",
  request_changes: "request_changes",
  answer_question: "answer_question",
  answer_provider_request: "answer_provider_request",
  answer_pane_prompt: "answer_pane_prompt",
  retry_task: "retry",
  cancel_task: "cancel",
} as const;
const humanSchema = (type: string) => {
  const schema = humanCommand.options.find(
    (option) => option.shape.type.value === type,
  );
  if (!schema) throw new Error("Unknown human command");
  return (schema as z.ZodObject).omit({ type: true }).extend({ taskId });
};
const create = command.options.find(
  (option) => option.shape.kind.value === "create_task",
);
if (!create) throw new Error("Missing create_task command");
export const mainNoteSchema = z.string().max(2000);
export const messageAgentSchema = z.strictObject({
  to: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("run"), taskId, runId }),
    z.strictObject({
      kind: z.literal("task"),
      taskId,
      role: z.enum(["planner", "implementer", "reviewer"]),
    }),
  ]),
  text: z.string().min(1).max(4000),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export const messageAgentResultSchema = z.strictObject({
  delivered: z.enum(["queued", "refused"]),
  reason: z.string().optional(),
});
export const leadInputSchemas = {
  message_agent: messageAgentSchema,
  set_note: z.strictObject({ note: mainNoteSchema }),
  list_tasks: z.strictObject({}),
  inspect_task: z.strictObject({ taskId }),
  list_repos: z.strictObject({}),
  create_task: (create as z.ZodObject)
    .omit({ kind: true })
    .extend({ repoId: repoId.optional() }),
  ...Object.fromEntries(
    Object.entries(humanTypes).map(([name, type]) => [name, humanSchema(type)]),
  ),
} as Record<string, z.ZodObject>;
export const leadToolNames = Object.keys(leadInputSchemas);

export function leadCommand(
  name: string,
  input: Record<string, unknown>,
): Command {
  if (name === "create_task") return command.parse({ kind: name, ...input });
  const type = humanTypes[name as keyof typeof humanTypes];
  if (!type) throw new Error("Not a Main command");
  const { taskId, ...fields } = input;
  return command.parse({ kind: "human", taskId, command: { type, ...fields } });
}
export interface LeadHost {
  invoke(
    name: string,
    input: Record<string, unknown>,
    repoId?: string,
  ): Promise<unknown>;
}
