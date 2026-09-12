// Lead tools reuse the protocol boundary and the human command path. No stage rules live here.

import type { Command } from "@loom/protocol";
import { command, humanCommand, taskId } from "@loom/protocol";
import { z } from "zod";

const humanTypes = {
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
export const leadInputSchemas = {
  list_tasks: z.strictObject({}),
  inspect_task: z.strictObject({ taskId }),
  list_repos: z.strictObject({}),
  create_task: (create as z.ZodObject).omit({ kind: true }),
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
  if (!type) throw new Error("Not a Lead command");
  const { taskId, ...fields } = input;
  return command.parse({ kind: "human", taskId, command: { type, ...fields } });
}
export interface LeadHost {
  invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
}
