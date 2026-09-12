// One instance's settings. `LOOM_INSTANCE` and `LOOM_DATA_ROOT` have no implicit production
// default: a development coordinator must never open the stable instance's database.

import { hostname } from "node:os";
import type { Provider, ReconcileConfig } from "@loom/core";
import { z } from "zod";
import { deriveClaudeSessionId, sha256 } from "./derive.js";

export const COORDINATOR_VERSION = "0.0.0";

const instance = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "instance must be a plain name");

const bind = z
  .string()
  .default("127.0.0.1:47800")
  .transform((value, ctx) => {
    const match = value.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    if (!match) {
      ctx.addIssue({ code: "custom", message: "expected host:port" });
      return z.NEVER;
    }
    return {
      host: match[1]?.replace(/^\[|\]$/g, "") ?? "127.0.0.1",
      port: Number(match[2]),
    };
  })
  .refine((v) => v.port >= 0 && v.port <= 65535, "port out of range");

export const configSchema = z.object({
  instance,
  dataRoot: z.string().min(1),
  /** Where task worktrees are created. Never inside a repository. */
  worktreeRoot: z.string().startsWith("/"),
  baseBranch: z.string().min(1).default("main"),
  bind,
  /** Compared in constant time on every `hello`. Absence is an error, not an open socket. */
  token: z.string().min(16),
  models: z.object({ codex: z.string().min(1), claude: z.string().min(1) }),
  /** GitHub logins Loom and its agents push as; their comments are not findings. */
  excludedAuthors: z.array(z.string().min(1)).default([]),
  caps: z
    .object({ total: z.number().int().positive(), codex: z.number().int().positive(), claude: z.number().int().positive() })
    .default({ total: 4, codex: 3, claude: 3 }),
  retry: z
    .object({
      baseMs: z.number().int().positive(),
      capMs: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
    })
    .default({ baseMs: 10_000, capMs: 300_000, maxAttempts: 3 }),
  stallAfterMs: z.number().int().positive().default(900_000),
  unknownGraceMs: z.number().int().positive().default(60_000),
  deliveryTimeoutMs: z.number().int().positive().default(10_000),
  githubPollMs: z.number().int().positive().default(60_000),
  /** The full resync: every non-terminal task gets a pass about this often (design §5.1). */
  resyncMs: z.number().int().positive().default(60_000),
  heartbeatMs: z.number().int().positive().default(15_000),
  tmuxExecutable: z.string().min(1).default("tmux"),
  codexExecutable: z.string().min(1).default("codex"),
  claudeExecutable: z.string().min(1).default("claude"),
});

export type CoordinatorConfig = z.output<typeof configSchema>;

/** The subset core sees. The pure functions are injected here, never serialized. */
export const reconcileConfig = (config: CoordinatorConfig): ReconcileConfig => ({
  retry: config.retry,
  stallAfterMs: config.stallAfterMs,
  unknownGraceMs: config.unknownGraceMs,
  deliveryTimeoutMs: config.deliveryTimeoutMs,
  githubPollMs: config.githubPollMs,
  deriveClaudeSessionId,
  sha256,
  worktreeRoot: config.worktreeRoot,
  baseBranch: config.baseBranch,
  models: config.models as Record<Provider, string>,
});

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** Reads the environment. Every value is validated; nothing falls back to the stable instance. */
export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorConfig {
  const optional = (name: string) => env[name] || undefined;
  return configSchema.parse({
    instance: env.LOOM_INSTANCE ?? required("LOOM_INSTANCE"),
    dataRoot: env.LOOM_DATA_ROOT ?? required("LOOM_DATA_ROOT"),
    worktreeRoot: env.LOOM_WORKTREE_ROOT ?? `${required("LOOM_DATA_ROOT")}/worktrees`,
    baseBranch: optional("LOOM_BASE_BRANCH"),
    bind: optional("LOOM_BIND"),
    token: env.LOOM_TOKEN ?? required("LOOM_TOKEN"),
    models: {
      codex: env.LOOM_MODEL_CODEX ?? "gpt-5.1-codex",
      claude: env.LOOM_MODEL_CLAUDE ?? "claude-opus-5",
    },
    excludedAuthors: optional("LOOM_EXCLUDED_AUTHORS")?.split(",").map((v) => v.trim()).filter(Boolean),
    tmuxExecutable: optional("LOOM_TMUX"),
    codexExecutable: optional("LOOM_CODEX"),
    claudeExecutable: optional("LOOM_CLAUDE"),
  });
}

/** A stable name for this coordinator run, so clients notice a restart. */
export const epochOf = (startedAt: string): string =>
  `${hostname()}:${process.pid}:${startedAt}`;
