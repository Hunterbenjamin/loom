import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
export function sanitizeEvidence(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/(?:Bearer\s+|\bsk-(?:proj-)?)[A-Za-z0-9_./+\-=]+/gi, "[secret]")
    .replace(
      /\b(?:[a-z0-9]+[_-])*(?:token|password|secret|api[_-]?key|authorization)\b["']?\s*[=:]\s*["']?[^\s,"'}]+/gi,
      "[secret]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .slice(0, 8000);
}
export function normalizeFailure(kind: string, message: string): string {
  return `v1:${kind}:${sanitizeEvidence(message)
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/g, "<time>")
    .replace(/\bt-[a-z0-9-]+(?:\/[a-z]+\/\d+)?\b/gi, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/(?:\/[\w.~-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500)}`;
}
export const eventKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
