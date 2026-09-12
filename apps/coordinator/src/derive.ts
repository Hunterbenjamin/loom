// The pure functions core needs injected, and the coordinator's own identifiers.
// Core stays free of Node APIs (decision 19), so the hashing lives here.

import { createHash, randomBytes } from "node:crypto";
import type { ProviderSessionId, RunId } from "@loom/core";

export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** UUIDv5 of `loom.dev` in the DNS namespace. Stable for the life of the product. */
export const LOOM_NAMESPACE = "921a648c-261b-527c-9cd6-54612de91f42";

const parseUuid = (uuid: string): Buffer => {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Not a UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
};

/** RFC 4122 §4.3, SHA-1. Pure: the same name always gives the same UUID. */
export function uuidV5(name: string, namespace = LOOM_NAMESPACE): string {
  const digest = createHash("sha1")
    .update(parseUuid(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // biome-ignore lint/style/noNonNullAssertion: a 16-byte buffer has these indexes.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  // biome-ignore lint/style/noNonNullAssertion: a 16-byte buffer has these indexes.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Decision 10: a Claude session is the UUIDv5 of `<runId>#<sessionEpoch>`. */
export const deriveClaudeSessionId = (
  run: RunId,
  epoch: number,
): ProviderSessionId => uuidV5(`${run}#${epoch}`) as ProviderSessionId;

/** One unguessable MCP token per run. Never derived from an ID (decision 14). */
export const newToken = (): string => randomBytes(32).toString("base64url");
