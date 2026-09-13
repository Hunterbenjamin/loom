// One instance's settings. `LOOM_INSTANCE` and `LOOM_DATA_ROOT` have no implicit production
// default: a development coordinator must never open the stable instance's database.

import { hostname } from "node:os";
import {
  DEFAULT_SETTINGS,
  type Provider,
  type ReconcileConfig,
  type Role,
  type RunMode,
  resolveSettings,
  type SettingsPatch,
} from "@loom/core";
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

const port = z.number().int().min(1).max(65535);

/**
 * An ephemeral bind (port 0, as tests use) gets ephemeral neighbours; a fixed bind gets fixed
 * ones, so a restart keeps the URLs written into every live run's settings valid.
 */
const derivedPort = (bindPort: number, offset: number): number =>
  bindPort === 0 ? 0 : bindPort + offset;

/**
 * Parse LOOM_RUN_MODES format: "role1=mode1,role2=mode2,..."
 * Defaults all roles to "interactive" if not specified.
 * Validates format and rejects invalid roles or modes.
 */
function parseRunModes(value?: string): Record<Role, RunMode> {
  const defaults: Record<Role, RunMode> = {
    planner: "interactive",
    implementer: "interactive",
    reviewer: "interactive",
  };

  if (!value) return defaults;

  const parsed: Partial<Record<Role, RunMode>> = {};
  const parts = value.split(",").map((p) => p.trim());
  const validRoles: Role[] = ["planner", "implementer", "reviewer"];
  const validModes: RunMode[] = ["interactive", "headless"];

  for (const part of parts) {
    if (!part) {
      throw new Error(
        'Invalid LOOM_RUN_MODES entry: expected "role=mode" format',
      );
    }

    const segments = part.split("=");
    if (segments.length !== 2) {
      throw new Error(
        `Invalid LOOM_RUN_MODES entry "${part}": expected "role=mode" format`,
      );
    }

    const [role, mode] = segments.map((s) => s.trim());

    if (!validRoles.includes(role as Role)) {
      throw new Error(
        `Invalid role in LOOM_RUN_MODES: "${role}". Valid roles: ${validRoles.join(", ")}`,
      );
    }

    if (!validModes.includes(mode as RunMode)) {
      throw new Error(
        `Invalid mode in LOOM_RUN_MODES: "${mode}". Valid modes: ${validModes.join(", ")}`,
      );
    }

    parsed[role as Role] = mode as RunMode;
  }

  return { ...defaults, ...parsed };
}

export const configSchema = z
  .object({
    instance,
    dataRoot: z.string().min(1),
    /** Where task worktrees are created. Never inside a repository. */
    worktreeRoot: z.string().startsWith("/"),
    baseBranch: z.string().min(1).default("main"),
    bind,
    /** Stable port for the MCP HTTP server; defaults to bind.port+1. */
    mcpPort: port.optional(),
    /** Stable port for the Claude hook receiver; defaults to bind.port+2. */
    hookPort: port.optional(),
    /** Compared in constant time on every `hello`. Absence is an error, not an open socket. */
    token: z.string().min(16),
    operatorModel: z.string().min(1).optional(),
    operator: z
      .object({
        policy: z.literal("v1").default("v1"),
        autoFix: z
          .array(z.enum(["pass_failed", "publish_failed", "stale_process"]))
          .default([]),
        maxFiledPerHour: z.number().int().positive().default(5),
        repoId: z.string().min(1).optional(),
      })
      .prefault({}),
    leadModel: z.string().min(1).optional(),
    models: z.object({ codex: z.string().min(1), claude: z.string().min(1) }),
    providerOverrides: z
      .object({
        planner: z.enum(["codex", "claude"]).optional(),
        implementer: z.enum(["codex", "claude"]).optional(),
        reviewer: z.enum(["codex", "claude"]).optional(),
      })
      .default({}),
    codexReasoningEffort: z
      .enum([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
      .optional(),
    /** GitHub logins Loom and its agents push as; their comments are not findings. */
    excludedAuthors: z.array(z.string().min(1)).default([]),
    caps: z
      .object({
        total: z.number().int().positive(),
        codex: z.number().int().positive(),
        claude: z.number().int().positive(),
      })
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
    runModes: z
      .string()
      .optional()
      .transform((value) => parseRunModes(value)),
    agentAccess: z.enum(["full", "approval-gated"]).default("full"),
    settingsEnvironment: z.custom<SettingsPatch>().default({}),
  })
  .transform((config) => ({
    ...config,
    mcpPort: config.mcpPort ?? derivedPort(config.bind.port, 1),
    hookPort: config.hookPort ?? derivedPort(config.bind.port, 2),
  }));

export type CoordinatorConfig = z.output<typeof configSchema>;

/** The subset core sees. The pure functions are injected here, never serialized. */
export const reconcileConfig = (config: CoordinatorConfig): ReconcileConfig => {
  return {
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
    runModes: config.runModes,
    providerOverrides: config.providerOverrides,
    codexReasoningEffort: config.codexReasoningEffort,
    ...(config.settingsEnvironment.roles
      ? {
          roleProfiles: resolveSettings(null, null, config.settingsEnvironment)
            .effective.roles,
        }
      : {}),
  };
};

const required = (
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** Reads the environment. Every value is validated; nothing falls back to the stable instance. */
export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorConfig {
  const optional = (name: string) => env[name] || undefined;
  const bindStr = optional("LOOM_BIND") ?? "127.0.0.1:47800";
  const bindMatch = bindStr.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  const bindPort = bindMatch ? Number(bindMatch[2]) : 47800;

  const parsed = configSchema.parse({
    instance: env.LOOM_INSTANCE ?? required("LOOM_INSTANCE", env),
    dataRoot: env.LOOM_DATA_ROOT ?? required("LOOM_DATA_ROOT", env),
    worktreeRoot:
      env.LOOM_WORKTREE_ROOT ?? `${required("LOOM_DATA_ROOT", env)}/worktrees`,
    baseBranch: optional("LOOM_BASE_BRANCH"),
    bind: optional("LOOM_BIND"),
    token: env.LOOM_TOKEN ?? required("LOOM_TOKEN", env),
    models: {
      codex: env.LOOM_MODEL_CODEX ?? "gpt-5.1-codex",
      claude: env.LOOM_MODEL_CLAUDE ?? "claude-opus-5",
    },
    providerOverrides: {
      planner: optional("LOOM_PROVIDER_PLANNER"),
      implementer: optional("LOOM_PROVIDER_IMPLEMENTER"),
      reviewer: optional("LOOM_PROVIDER_REVIEWER"),
    },
    codexReasoningEffort: optional("LOOM_CODEX_REASONING_EFFORT"),
    operatorModel: optional("LOOM_MODEL_OPERATOR"),
    operator: {
      repoId: optional("LOOM_OPERATOR_REPO"),
      autoFix: optional("LOOM_OPERATOR_AUTO_FIX")?.split(",").filter(Boolean),
      maxFiledPerHour: env.LOOM_OPERATOR_MAX_FILED_PER_HOUR
        ? Number(env.LOOM_OPERATOR_MAX_FILED_PER_HOUR)
        : undefined,
    },
    leadModel: optional("LOOM_MODEL_LEAD"),
    excludedAuthors: optional("LOOM_EXCLUDED_AUTHORS")
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    // Parallel-run caps. The defaults suit one person's rate limits; a dev instance building
    // Loom with Loom queued planners behind them for an hour on 2026-09-12.
    caps:
      env.LOOM_CAP_TOTAL || env.LOOM_CAP_CODEX || env.LOOM_CAP_CLAUDE
        ? {
            total: Number(env.LOOM_CAP_TOTAL ?? 4),
            codex: Number(env.LOOM_CAP_CODEX ?? 3),
            claude: Number(env.LOOM_CAP_CLAUDE ?? 3),
          }
        : undefined,
    tmuxExecutable: optional("LOOM_TMUX"),
    codexExecutable: optional("LOOM_CODEX"),
    claudeExecutable: optional("LOOM_CLAUDE"),
    runModes: optional("LOOM_RUN_MODES"),
    agentAccess: optional("LOOM_AGENT_ACCESS"),
    mcpPort: env.LOOM_MCP_PORT
      ? Number(env.LOOM_MCP_PORT)
      : derivedPort(bindPort, 1),
    hookPort: env.LOOM_HOOK_PORT
      ? Number(env.LOOM_HOOK_PORT)
      : derivedPort(bindPort, 2),
  });
  const rolePatch: SettingsPatch["roles"] = {};
  for (const role of ["planner", "implementer", "reviewer"] as const) {
    const provider =
      parsed.providerOverrides[role] ?? DEFAULT_SETTINGS.roles[role].provider;
    const value: Partial<(typeof DEFAULT_SETTINGS.roles)[typeof role]> = {};
    if (env[`LOOM_PROVIDER_${role.toUpperCase()}`]) value.provider = provider;
    const modelName =
      provider === "codex" ? "LOOM_MODEL_CODEX" : "LOOM_MODEL_CLAUDE";
    if (env[modelName]) value.model = parsed.models[provider];
    if (env.LOOM_CODEX_REASONING_EFFORT && provider === "codex")
      value.reasoningEffort = parsed.codexReasoningEffort as never;
    if (env.LOOM_RUN_MODES) value.runMode = parsed.runModes[role];
    if (env.LOOM_AGENT_ACCESS) value.access = parsed.agentAccess;
    if (Object.keys(value).length) rolePatch[role] = value;
  }
  const settingsEnvironment: SettingsPatch = {
    ...(Object.keys(rolePatch).length ? { roles: rolePatch } : {}),
    operator: {
      ...(env.LOOM_MODEL_OPERATOR
        ? { model: parsed.operatorModel ?? null }
        : {}),
      ...(env.LOOM_MODEL_LEAD ? { leadModel: parsed.leadModel ?? null } : {}),
      ...(env.LOOM_OPERATOR_REPO
        ? { repoId: parsed.operator.repoId ?? null }
        : {}),
      ...(env.LOOM_OPERATOR_AUTO_FIX
        ? { autoFix: parsed.operator.autoFix }
        : {}),
      ...(env.LOOM_OPERATOR_MAX_FILED_PER_HOUR
        ? { maxFiledPerHour: parsed.operator.maxFiledPerHour }
        : {}),
    },
    runtime: {
      ...(env.LOOM_CAP_TOTAL ? { capTotal: parsed.caps.total } : {}),
      ...(env.LOOM_CAP_CODEX ? { capCodex: parsed.caps.codex } : {}),
      ...(env.LOOM_CAP_CLAUDE ? { capClaude: parsed.caps.claude } : {}),
      ...(env.LOOM_WORKTREE_ROOT ? { worktreeRoot: parsed.worktreeRoot } : {}),
      ...(env.LOOM_TMUX ? { tmuxExecutable: parsed.tmuxExecutable } : {}),
      ...(env.LOOM_CODEX ? { codexExecutable: parsed.codexExecutable } : {}),
      ...(env.LOOM_CLAUDE ? { claudeExecutable: parsed.claudeExecutable } : {}),
      ...(env.LOOM_EXCLUDED_AUTHORS
        ? { excludedAuthors: parsed.excludedAuthors }
        : {}),
    },
    ...(env.LOOM_WINDOW_MODE
      ? {
          appearance: {
            windowMode: z
              .enum(["tracker", "workbench"])
              .parse(env.LOOM_WINDOW_MODE),
          },
        }
      : {}),
    ...(env.LOOM_BASE_BRANCH
      ? { repository: { baseBranch: parsed.baseBranch } }
      : {}),
  };
  return { ...parsed, settingsEnvironment };
}

/** A stable name for this coordinator run, so clients notice a restart. */
export const epochOf = (startedAt: string): string =>
  `${hostname()}:${process.pid}:${startedAt}`;
