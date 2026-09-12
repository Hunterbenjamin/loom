import { z } from "zod";
import { leadInputSchemas } from "./lead.js";

const event = z.strictObject({ eventId: z.string().min(1) });
export const operatorInputSchemas: Record<string, z.ZodObject> = {
  ...Object.fromEntries(
    Object.keys(leadInputSchemas).map((name) => [
      name,
      ["list_tasks", "list_repos", "inspect_task"].includes(name)
        ? leadInputSchemas[name]
        : event,
    ]),
  ),
  operator_events: z.strictObject({}),
  append_note: event,
  file_task: z.strictObject({
    eventId: z.string().min(1),
    title: z.string().min(1).max(200),
    summary: z
      .string()
      .min(1)
      .max(140)
      .regex(/^[^\r\n]*$/, "Summary must be one line"),
    description: z.string().min(1).max(6000),
    acceptanceTest: z.string().min(10).max(3000),
  }),
};
