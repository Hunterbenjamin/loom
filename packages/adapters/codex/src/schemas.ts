import { z } from "zod";

export const identifier = z.string().min(1);
export const unixSeconds = z.number().finite().min(0).max(8_640_000_000_000);
export const status = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
  }),
  z.object({ type: z.enum(["idle", "systemError", "notLoaded"]) }),
]);
export const providerError = z.object({
  message: z.string(),
  codexErrorInfo: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .nullable(),
});
const userContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.enum([
      "image",
      "localImage",
      "audio",
      "localAudio",
      "skill",
      "mention",
    ]),
  }),
]);
const item = z.union([
  z.object({ type: z.literal("userMessage"), content: z.array(userContent) }),
  z.object({ type: identifier.refine((type) => type !== "userMessage") }),
]);
export const turn = z.object({
  id: identifier,
  status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
  items: z.array(item),
  itemsView: z.literal("full"),
  error: providerError.nullable(),
  startedAt: unixSeconds.nullable(),
  completedAt: unixSeconds.nullable(),
});
export const threadMetadata = z.object({
  id: identifier,
  cwd: z.string().startsWith("/"),
  status,
  updatedAt: unixSeconds,
});
export const threadResult = z.object({
  thread: threadMetadata.extend({ turns: z.array(turn) }),
});
export const metadataResult = z.object({ thread: threadMetadata });
export const turnResult = z.object({
  turn: z.object({
    id: identifier,
    status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
  }),
});
const window = z.object({
  usedPercent: z.number().finite().nonnegative(),
  resetsAt: unixSeconds.nullable(),
});
const bucket = z.object({
  primary: window.nullable(),
  secondary: window.nullable(),
});
export const rateLimitsResult = z.object({
  ordinaryUsageAllowed: z.boolean().nullable(),
  rateLimits: bucket,
  rateLimitsByLimitId: z.record(z.string(), bucket).nullable(),
});
export type Thread = z.infer<typeof threadResult>["thread"];
export type ProviderError = z.infer<typeof providerError>;

const requestBase = z.object({
  threadId: identifier,
  turnId: identifier,
  itemId: identifier,
});
const specialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["root", "minimal", "tmpdir", "slash_tmp"]) }),
  z.object({
    kind: z.literal("project_roots"),
    subpath: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("unknown"),
    path: z.string(),
    subpath: z.string().nullable(),
  }),
]);
const filePath = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: z.string() }),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }),
  z.object({ type: z.literal("special"), value: specialPath }),
]);
const fileSystem = z.object({
  read: z.array(z.string()).nullable(),
  write: z.array(z.string()).nullable(),
  globScanMaxDepth: z.number().int().nonnegative().optional(),
  entries: z
    .array(
      z.object({ path: filePath, access: z.enum(["read", "write", "deny"]) }),
    )
    .optional(),
});
const network = z.object({ enabled: z.boolean().nullable() });
export const commandRequest = requestBase.extend({
  command: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  availableDecisions: z
    .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
    .nullable()
    .optional(),
});
export const fileRequest = requestBase.extend({
  reason: z.string().nullable().optional(),
});
export const permissionRequest = requestBase.extend({
  permissions: z.object({
    network: network.nullable(),
    fileSystem: fileSystem.nullable(),
  }),
});
export const questionRequest = requestBase.extend({
  isBlocking: z.boolean(),
  questions: z.array(z.object({ id: identifier, question: z.string() })).min(1),
});
