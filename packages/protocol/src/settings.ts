import { z } from "zod";
import { isoTime, repoId } from "./ids.js";

export const settingsScope = z.union([
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("repository"), repoId }),
]);

export const reasoningEffort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const roleProfile = z.strictObject({
  provider: z.enum(["codex", "claude"]),
  model: z.string().min(1),
  reasoningEffort: reasoningEffort.nullable(),
  runMode: z.enum(["interactive", "headless"]),
  access: z.enum(["full", "approval-gated"]),
});
export const settingsValues = z.strictObject({
  roles: z.strictObject({
    planner: roleProfile,
    implementer: roleProfile,
    reviewer: roleProfile,
  }),
  workflow: z.strictObject({
    requirePlanApproval: z.boolean(),
    size: z.enum(["small", "normal"]),
    budgetMinutes: z.number().int().positive().nullable(),
    reviewRoundCap: z.number().int().positive(),
    mergePolicy: z.enum(["require-human", "auto-small", "auto-all"]),
  }),
  operator: z.strictObject({
    model: z.string().min(1).nullable(),
    leadModel: z.string().min(1).nullable(),
    repoId: z.string().min(1).nullable(),
    autoFix: z.array(
      z.enum(["pass_failed", "publish_failed", "stale_process"]),
    ),
    maxFiledPerHour: z.number().int().positive(),
  }),
  runtime: z.strictObject({
    capTotal: z.number().int().positive(),
    capCodex: z.number().int().positive(),
    capClaude: z.number().int().positive(),
    retryBaseMs: z.number().int().positive(),
    retryCapMs: z.number().int().positive(),
    retryMaxAttempts: z.number().int().positive(),
    stallAfterMs: z.number().int().positive(),
    unknownGraceMs: z.number().int().positive(),
    deliveryTimeoutMs: z.number().int().positive(),
    githubPollMs: z.number().int().positive(),
    resyncMs: z.number().int().positive(),
    heartbeatMs: z.number().int().positive(),
    worktreeRoot: z.string().min(1),
    tmuxExecutable: z.string().min(1),
    codexExecutable: z.string().min(1),
    claudeExecutable: z.string().min(1),
    excludedAuthors: z.array(z.string().min(1)),
  }),
  appearance: z.strictObject({
    theme: z.enum(["dark", "light", "system"]),
    chime: z.boolean(),
    windowMode: z.enum(["tracker", "workbench"]),
    terminalHistoryLimit: z.number().int().positive(),
    keyPrefix: z.string().min(1),
    keyTimeoutMs: z.number().int().positive(),
  }),
});

export const settingsPatch = z.strictObject({
  roles: z
    .partialRecord(
      z.enum(["planner", "implementer", "reviewer"]),
      roleProfile.partial(),
    )
    .optional(),
  workflow: settingsValues.shape.workflow.partial().optional(),
  operator: settingsValues.shape.operator.partial().optional(),
  runtime: settingsValues.shape.runtime.partial().optional(),
  appearance: settingsValues.shape.appearance.partial().optional(),
});

export const settingDefinition = z.strictObject({
  key: z.string().min(1),
  section: z.enum([
    "Agents & models",
    "Workflow & approvals",
    "Access & safety",
    "Operator & Main",
    "Terminals & keybindings",
    "GitHub",
    "Appearance",
    "Advanced runtime",
  ]),
  label: z.string().min(1),
  timing: z.enum(["immediate", "next-task", "next-run", "restart-required"]),
  environment: z.string().min(1).optional(),
});

export const settingsAudit = z.strictObject({
  id: z.number().int(),
  scope: settingsScope,
  actor: z.string().min(1),
  changedAt: isoTime,
  settingKey: z.string().min(1),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  settingsVersion: z.number().int().positive(),
});

export const settingsDocument = z.strictObject({
  id: z.string().min(1),
  scope: settingsScope,
  version: z.number().int().nonnegative(),
  stored: settingsPatch,
  defaults: settingsValues,
  effective: settingsValues,
  sources: z.record(
    z.string(),
    z.enum(["environment", "repository", "global", "default"]),
  ),
  catalog: z.array(settingDefinition),
  modelCatalog: z.object({
    version: z.number().int().positive(),
    updatedAt: z.string(),
    providers: z.record(
      z.string(),
      z.object({ models: z.array(z.string()), reasoning: z.array(z.string()) }),
    ),
  }),
  credentialReadiness: z.strictObject({
    codex: z.boolean(),
    claude: z.boolean(),
    github: z.boolean(),
  }),
  audit: z.array(settingsAudit),
});

export type SettingsDocument = z.output<typeof settingsDocument>;
