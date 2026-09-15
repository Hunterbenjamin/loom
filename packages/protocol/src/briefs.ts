import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
export const briefContent = z.strictObject({
  headline: z.string().trim().min(1).max(200),
  summary: text,
  items: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        category: z.enum(["workflow", "capability", "business", "research"]),
        publishedOn: z.string().date().nullable(),
        whatChanged: text,
        implication: text,
        evidence: z.enum([
          "independently_tested",
          "author_reported",
          "practitioner_experience",
          "opinion",
        ]),
        caveat: text,
        nextStep: text,
        sources: z
          .array(
            z.strictObject({
              title: z.string().min(1).max(200),
              url: z
                .url()
                .max(2000)
                .refine(
                  (url) => /^https?:\/\//.test(url),
                  "HTTP(S) source required",
                ),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .max(5),
  workflowExperiment: text,
  opportunity: text.nullable(),
  coverage: text,
});
export type BriefContent = z.infer<typeof briefContent>;
export const briefRunSummary = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  trigger: z.enum(["scheduled", "manual"]),
  scheduledDate: z.string().date().nullable(),
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  model: z.string().min(1),
  error: z.string().max(2000).nullable(),
});
export type BriefRunSummary = z.infer<typeof briefRunSummary>;
export const briefRun = briefRunSummary.extend({
  content: briefContent.nullable(),
});
export type BriefRun = z.infer<typeof briefRun>;
export const briefSchedule = z.strictObject({
  enabled: z.boolean(),
  hour: z.literal(7),
  timeZone: z.literal("Asia/Makassar"),
});
export const briefState = z.strictObject({
  schedule: briefSchedule,
  runs: z.array(briefRunSummary).max(30),
});
export type BriefState = z.infer<typeof briefState>;
