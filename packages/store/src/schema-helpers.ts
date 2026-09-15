import { storedEntities } from "@loom/protocol";
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
export {
  artifactKind,
  findingStatus,
  provider,
  role,
  sendVia,
  severity,
  side,
} from "@loom/protocol";
export const { paneRef, transportAttempt } = storedEntities;
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
