import { z } from "zod";
export const taskNote = z.strictObject({
  id: z.string(),
  taskId: z.string().nullable(),
  repoId: z.string().optional(),
  author: z.enum(["main", "lead", "human"]),
  at: z.string().datetime(),
  eventId: z.string(),
  row: z.string(),
  outcome: z.string(),
  body: z.string().max(16000),
  forHuman: z.boolean(),
  occurrence: z.string(),
});
