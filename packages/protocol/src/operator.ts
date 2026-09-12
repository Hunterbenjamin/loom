import { z } from "zod";
export const taskNote = z.strictObject({
  id: z.string(),
  taskId: z.string().nullable(),
  author: z.enum(["operator", "lead", "human"]),
  at: z.string().datetime(),
  eventId: z.string(),
  row: z.string(),
  outcome: z.string(),
  body: z.string().max(16000),
  forHuman: z.boolean(),
  occurrence: z.string(),
});
export const operatorState = z.strictObject({
  id: z.literal("operator"),
  sessionId: z.string().nullable(),
  status: z.enum(["stopped", "idle", "working", "error"]),
  queueLength: z.number().int().nonnegative(),
  lastAction: z.string().nullable(),
  lastActionAt: z.string().datetime().nullable(),
  actions: z.array(taskNote).max(10),
  filedThisHour: z.number().int().nonnegative(),
  error: z.string().nullable(),
  escalation: z.string().nullable(),
});
export type OperatorState = z.output<typeof operatorState>;
