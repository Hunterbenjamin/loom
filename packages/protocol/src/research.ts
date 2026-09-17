import { z } from "zod";

export const researchName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[^\r\n]*$/, "Name must be one line");

export const researchQuestion = z.string().trim().min(1).max(10000);
export const researchDocument = z.strictObject({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(100000),
  sources: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(300),
        // A source is either a page or a file the run read inside its own directory. Local
        // citations are relative paths, which cannot name anything outside that scope the way an
        // absolute path or a file:// URL could, and which stay readable once the document moves.
        url: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .refine(
            (value) =>
              /^https?:\/\//.test(value) ||
              (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) &&
                !value.startsWith("/") &&
                !value.startsWith("\\") &&
                !value.split(/[/\\]/).includes("..")),
            "Source must be an HTTP(S) link or a path inside the research directory",
          ),
      }),
    )
    .min(1)
    .max(100),
});
export type ResearchDocument = z.infer<typeof researchDocument>;
export const researchEntry = z.strictObject({
  id: z.string().uuid(),
  name: researchName,
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

export const researchCommentText = z.string().trim().min(1).max(16384);
export const researchComment = z.strictObject({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  author: z.enum(["human", "main", "agent"]),
  text: researchCommentText,
  at: z.string().datetime(),
  delivered: z.boolean(),
});
export type ResearchComment = z.infer<typeof researchComment>;
export const mentionsLoom = (text: string): boolean => /@loom\b/i.test(text);
