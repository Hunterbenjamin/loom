import { z } from "zod";

export const researchQuestion = z.string().trim().min(1).max(10000);
export const researchDocument = z.strictObject({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(100000),
  sources: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(300),
        url: z
          .url()
          .max(2000)
          .refine((url) => /^https?:\/\//.test(url), "HTTP(S) source required"),
      }),
    )
    .min(1)
    .max(100),
});
export type ResearchDocument = z.infer<typeof researchDocument>;
export const researchEntry = z.strictObject({
  id: z.string().uuid(),
  question: researchQuestion,
  origin: z.enum(["agent", "main"]),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  directory: z.string().nullable().default(null),
  pane: z
    .object({
      hostGeneration: z.string(),
      sessionName: z.string(),
      windowId: z.string(),
      paneId: z.string(),
    })
    .nullable()
    .default(null),
  observedStatus: z
    .enum(["working", "idle", "waiting", "unknown", "ended"])
    .default("unknown"),
  sessionId: z.string().min(1).nullable(),
  provider: z.enum(["codex", "claude"]).nullable(),
  model: z.string().min(1).nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  error: z.string().max(120000).nullable(),
  document: researchDocument.nullable(),
});
export type ResearchEntry = z.infer<typeof researchEntry>;
export const researchSummary = researchEntry
  .omit({ document: true })
  .extend({ title: researchDocument.shape.title.nullable() });
export type ResearchSummary = z.infer<typeof researchSummary>;
export const researchState = z.strictObject({
  entries: z.array(researchSummary),
  runningId: z.string().uuid().nullable(),
});
export type ResearchState = z.infer<typeof researchState>;
