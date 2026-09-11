import { z } from "zod";

export const fixtureSchema = z.object({
  id: z.string(),
  description: z.string(),
  source: z.string(),
  patch: z.string(),
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  sha256: z.string(),
  contents: z.record(z.string(), z.object({ old: z.string(), new: z.string() })),
});
export type Fixture = z.infer<typeof fixtureSchema>;
export const manifestSchema = z.array(fixtureSchema.omit({ patch: true, contents: true }));
export const configSchema = z.object({
  fixture: z.string().default("medium"),
  workers: z.enum(["0", "1"]).default("1"),
  annotations: z.coerce.number().int().min(0).max(200).default(0),
  view: z.enum(["split", "unified"]).default("split"),
  renderer: z.enum(["codeview", "plain", "virtualizer"]).default("codeview"),
  theme: z.enum(["dark", "light"]).default("dark"),
  input: z.enum(["patch", "contents"]).default("patch"),
});
