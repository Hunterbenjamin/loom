import {
  PROVIDER_VALUES,
  ROLE_VALUES,
  RUN_MODE_VALUES,
  TASK_SIZE_VALUES,
} from "@loom/core";
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
  provider: z.enum(PROVIDER_VALUES),
  model: z.string().min(1),
  reasoningEffort: reasoningEffort.nullable(),
  runMode: z.enum(RUN_MODE_VALUES),
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
    size: z.enum(TASK_SIZE_VALUES),
    budgetMinutes: z.number().int().positive().nullable(),
    reviewRoundCap: z.number().int().positive(),
    mergePolicy: z.enum(["require-human", "auto-small", "auto-all"]),
  }),
  repository: z.strictObject({
    baseBranch: z.string().min(1),
    serialTests: z.boolean(),
  }),
  main: z.strictObject({ model: z.string().min(1).nullable() }),
  runtime: z.strictObject({
    capTotal: z.number().int().positive(),
    capCodex: z.number().int().positive(),
    capClaude: z.number().int().positive(),
    retryBaseMs: z.number().int().positive(),
    retryCapMs: z.number().int().positive(),
    retryMaxAttempts: z.number().int().positive(),
    stallAfterMs: z.number().int().positive(),
    fixRoundStallAfterMs: z.number().int().positive(),
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
    keyPrefix: z.string().min(1).nullable(),
    keyTimeoutMs: z.number().int().positive(),
    keybindings: z.record(z.string().min(1), z.array(z.string().min(1))),
  }),
});

export const settingsPatch = z.strictObject({
  roles: z.partialRecord(z.enum(ROLE_VALUES), roleProfile.partial()).optional(),
  workflow: settingsValues.shape.workflow.partial().optional(),
  repository: settingsValues.shape.repository.partial().optional(),
  main: settingsValues.shape.main.partial().optional(),
  runtime: settingsValues.shape.runtime.partial().optional(),
  appearance: settingsValues.shape.appearance.partial().optional(),
});

// Published stored documents are deliberately forward-compatible. Commands still use the
// strict schema above, so an older client cannot write fields it does not understand, while it
// can receive and round-trip additive fields already owned by a newer coordinator.
const storedRoleProfile = roleProfile.partial().passthrough();
export const storedSettingsPatch = z
  .object({
    roles: z
      .object({
        planner: storedRoleProfile.optional(),
        implementer: storedRoleProfile.optional(),
        reviewer: storedRoleProfile.optional(),
      })
      .passthrough()
      .optional(),
    workflow: settingsValues.shape.workflow.partial().passthrough().optional(),
    repository: settingsValues.shape.repository
      .partial()
      .passthrough()
      .optional(),
    main: settingsValues.shape.main.partial().passthrough().optional(),
    runtime: settingsValues.shape.runtime.partial().passthrough().optional(),
    appearance: settingsValues.shape.appearance
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough();

export const settingDefinition = z.strictObject({
  key: z.string().min(1),
  section: z.enum([
    "Agents & models",
    "Workflow & approvals",
    "Repositories",
    "Access & safety",
    "Main",
    "Terminals & keybindings",
    "GitHub",
    "Appearance",
    "Advanced runtime",
  ]),
  label: z.string().min(1),
  timing: z.enum(["immediate", "next-task", "next-run", "restart-required"]),
  environment: z.string().min(1).optional(),
  scopes: z.array(z.enum(["global", "repository"])).min(1),
  readOnly: z.boolean().optional(),
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
  stored: storedSettingsPatch,
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
