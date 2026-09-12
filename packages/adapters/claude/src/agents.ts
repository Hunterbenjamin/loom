// `claude agents --json`: the owner of live Claude status.
//
// It is the only source that sees an Esc interrupt, a crash, and the moment a permission is
// approved — none of which fire a hook (spike 02, §2). Hooks add detail on top of it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ClaudeAgentsEntry,
  ProviderSessionId,
  WorktreePath,
} from "@loom/core";
import { z } from "zod";

const exec = promisify(execFile);

/** Seen in 2.1.269: `busy`, `waiting`, `idle`. The full enum is undocumented, so anything else is `other`. */
const KNOWN_STATUSES = new Set(["busy", "waiting", "idle"]);
const KNOWN_KINDS = new Set(["interactive", "background"]);

/** Loose: 2.1.269 adds `name` and `startedAt`, and background entries carry `id` and `state`. */
const statusEntrySchema = z.looseObject({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  status: z.string().min(1),
  kind: z.string().min(1),
  pid: z.number().int().nullish(),
});

// Native background records use `state` instead of `status`. Validate that shape explicitly;
// missing status on an interactive session must still fail rather than imply it is idle.
export const agentsEntrySchema = z.union([
  statusEntrySchema,
  z
    .looseObject({
      sessionId: z.string().min(1),
      cwd: z.string().min(1),
      kind: z.literal("background"),
      status: z.undefined().optional(),
      state: z.string().min(1),
      pid: z.number().int().nullish(),
    })
    .transform((entry) => ({ ...entry, status: entry.state })),
]);

export const agentsOutputSchema = z.array(agentsEntrySchema);

export type RawAgentsEntry = z.infer<typeof agentsEntrySchema>;

/**
 * `cwd` is already the realpath: Claude reports `/private/var/...` where `$TMPDIR` says
 * `/var/...` (spike 02, §1), which is what makes it usable as the join key (principle 6).
 */
export const toAgentsEntry = (raw: RawAgentsEntry): ClaudeAgentsEntry => ({
  sessionId: raw.sessionId as ProviderSessionId,
  status: (KNOWN_STATUSES.has(raw.status) ? raw.status : "other") as
    | "busy"
    | "waiting"
    | "idle"
    | "other",
  rawStatus: raw.status,
  kind: (KNOWN_KINDS.has(raw.kind) ? raw.kind : "other") as
    | "interactive"
    | "background"
    | "other",
  pid: raw.pid ?? null,
  cwd: raw.cwd as WorktreePath,
});

export const parseAgentsOutput = (stdout: string): ClaudeAgentsEntry[] =>
  agentsOutputSchema.parse(JSON.parse(stdout)).map(toAgentsEntry);

export interface AgentsReaderOptions {
  /** Defaults to `claude` on PATH. */
  binary?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function readAgents(
  options: AgentsReaderOptions = {},
): Promise<ClaudeAgentsEntry[]> {
  const { stdout } = await exec(
    options.binary ?? "claude",
    ["agents", "--json"],
    {
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 8 * 1024 * 1024,
      ...(options.env ? { env: options.env } : {}),
    },
  );
  return parseAgentsOutput(stdout);
}
