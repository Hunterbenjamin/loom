import { z } from "zod";

// Core brands are compile-time only. Check the complete unbranded shape before branding it.
type Plain<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Plain<U>[]
    : T extends object
      ? { [K in keyof T]: Plain<T[K]> }
      : T;
export const contract =
  <T>() =>
  (schema: z.ZodType<Plain<T>>): z.ZodType<T> =>
    schema.transform((value) => value as T);
export const text = z.string();
export const id = text.min(1);
export const count = z.number().int().nonnegative();
export const positive = z.number().int().positive();
export const time = z.iso.datetime();
export const sha = text.regex(/^[0-9a-f]{40}$/);
export const hash = text.regex(/^[0-9a-f]{64}$/);
export const provider = z.enum(["codex", "claude"]);
export const role = z.enum(["planner", "implementer", "reviewer"]);
export const stage = z.enum([
  "backlog",
  "todo",
  "planning",
  "plan_approval",
  "in_progress",
  "in_review",
  "awaiting_approval",
  "merging",
  "done",
  "canceled",
]);
export const artifactKind = z.enum([
  "brief",
  "plan",
  "decisions",
  "findings",
  "test_results",
  "handoff",
]);
export const side = z.enum(["old", "new"]);
export const severity = z.enum(["blocker", "major", "minor", "nit"]);
export const findingStatus = z.enum([
  "open",
  "addressed",
  "disputed",
  "resolved",
  "waived",
]);
export const requestKind = z.enum([
  "command_approval",
  "file_approval",
  "permission",
  "question",
]);
export const sendVia = z.enum([
  "codex_turn_start",
  "codex_turn_steer",
  "pane_paste",
  "claude_sdk",
]);
export const blockedReason = z.enum([
  "dependencies",
  "question",
  "review_round_cap",
  "review_not_converging",
  "provider_cooling_down",
  "pr_closed",
]);
export const failedReason = z.enum([
  "retries_exhausted",
  "non_retryable_error",
  "action_failed",
]);
export const providerRules = z.object({
  planner: provider,
  implementer: provider,
  reviewer: provider,
});
export const paneRef = z.object({
  hostGeneration: text,
  sessionName: text,
  windowId: text,
  paneId: text,
});
export const errorSchema = z.object({
  code: z.enum(["retryable", "precondition", "fatal"]),
  message: text,
});
export function decode<T>(schema: z.ZodType<T>, raw: unknown): T {
  return schema.parse(JSON.parse(text.parse(raw)));
}
export function encode(value: unknown): string {
  // Optional core fields may explicitly be undefined; SQL JSON omits those keys.
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, strip(item)]),
      );
    }
    return v;
  };
  return JSON.stringify(z.json().parse(strip(value)));
}
