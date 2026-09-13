import type { Provider, Role, RunMode } from "./entities.js";

export type SettingsScope =
  | { kind: "global" }
  | { kind: "repository"; repoId: string };
export type SettingsSource =
  | "environment"
  | "repository"
  | "global"
  | "default";
export type ApplyTiming =
  | "immediate"
  | "next-task"
  | "next-run"
  | "restart-required";
export type MergePolicy = "require-human" | "auto-small" | "auto-all";
export type AccessPreset = "full" | "approval-gated";
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface RoleProfile {
  provider: Provider;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  runMode: RunMode;
  access: AccessPreset;
}

export interface SettingsValues {
  roles: Record<Role, RoleProfile>;
  workflow: {
    requirePlanApproval: boolean;
    size: "small" | "normal";
    budgetMinutes: number | null;
    reviewRoundCap: number;
    mergePolicy: MergePolicy;
  };
  operator: {
    model: string | null;
    leadModel: string | null;
    repoId: string | null;
    autoFix: ("pass_failed" | "publish_failed" | "stale_process")[];
    maxFiledPerHour: number;
  };
  runtime: {
    capTotal: number;
    capCodex: number;
    capClaude: number;
    retryBaseMs: number;
    retryCapMs: number;
    retryMaxAttempts: number;
    stallAfterMs: number;
    unknownGraceMs: number;
    deliveryTimeoutMs: number;
    githubPollMs: number;
    resyncMs: number;
    heartbeatMs: number;
    worktreeRoot: string;
    tmuxExecutable: string;
    codexExecutable: string;
    claudeExecutable: string;
    excludedAuthors: string[];
  };
  appearance: {
    theme: "dark" | "light" | "system";
    chime: boolean;
    windowMode: "tracker" | "workbench";
    terminalHistoryLimit: number;
    keyPrefix: string;
    keyTimeoutMs: number;
  };
}

export type SettingsPatch = {
  roles?: Partial<Record<Role, Partial<RoleProfile>>>;
  workflow?: Partial<SettingsValues["workflow"]>;
  operator?: Partial<SettingsValues["operator"]>;
  runtime?: Partial<SettingsValues["runtime"]>;
  appearance?: Partial<SettingsValues["appearance"]>;
};

export interface SettingDefinition {
  key: string;
  section:
    | "Agents & models"
    | "Workflow & approvals"
    | "Access & safety"
    | "Operator & Main"
    | "Terminals & keybindings"
    | "GitHub"
    | "Appearance"
    | "Advanced runtime";
  label: string;
  timing: ApplyTiming;
  environment?: string;
}

const codexModels = [
  "gpt-5.1-codex",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-6-astra",
];
const claudeModels = [
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
];
export const MODEL_CATALOG = {
  version: 1,
  updatedAt: "2026-09-13",
  providers: {
    codex: {
      models: codexModels,
      reasoning: [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
    },
    claude: { models: claudeModels, reasoning: [] },
  },
} as const;

const role = (provider: Provider, model: string): RoleProfile => ({
  provider,
  model,
  reasoningEffort: provider === "codex" ? "medium" : null,
  runMode: "interactive",
  access: "full",
});

export const DEFAULT_SETTINGS: SettingsValues = {
  roles: {
    planner: role("codex", "gpt-5.1-codex"),
    implementer: role("claude", "claude-opus-5"),
    reviewer: role("codex", "gpt-5.1-codex"),
  },
  workflow: {
    requirePlanApproval: false,
    size: "normal",
    budgetMinutes: null,
    reviewRoundCap: 3,
    mergePolicy: "require-human",
  },
  operator: {
    model: null,
    leadModel: null,
    repoId: null,
    autoFix: [],
    maxFiledPerHour: 5,
  },
  runtime: {
    capTotal: 4,
    capCodex: 3,
    capClaude: 3,
    retryBaseMs: 10_000,
    retryCapMs: 300_000,
    retryMaxAttempts: 3,
    stallAfterMs: 900_000,
    unknownGraceMs: 60_000,
    deliveryTimeoutMs: 10_000,
    githubPollMs: 60_000,
    resyncMs: 60_000,
    heartbeatMs: 15_000,
    worktreeRoot: "/tmp/loom-worktrees",
    tmuxExecutable: "tmux",
    codexExecutable: "codex",
    claudeExecutable: "claude",
    excludedAuthors: [],
  },
  appearance: {
    theme: "dark",
    chime: true,
    windowMode: "tracker",
    terminalHistoryLimit: 10_000,
    keyPrefix: "Ctrl-b",
    keyTimeoutMs: 500,
  },
};

export const SETTINGS_CATALOG: SettingDefinition[] = [
  ...(["planner", "implementer", "reviewer"] as Role[]).flatMap((name) => [
    {
      key: `roles.${name}.provider`,
      section: "Agents & models" as const,
      label: `${name} provider`,
      timing: "next-run" as const,
      environment: `LOOM_PROVIDER_${name.toUpperCase()}`,
    },
    {
      key: `roles.${name}.model`,
      section: "Agents & models" as const,
      label: `${name} model`,
      timing: "next-run" as const,
      environment: "LOOM_MODEL_CODEX / LOOM_MODEL_CLAUDE",
    },
    {
      key: `roles.${name}.reasoningEffort`,
      section: "Agents & models" as const,
      label: `${name} reasoning`,
      timing: "next-run" as const,
      environment: "LOOM_CODEX_REASONING_EFFORT",
    },
    {
      key: `roles.${name}.runMode`,
      section: "Agents & models" as const,
      label: `${name} run mode`,
      timing: "next-run" as const,
      environment: "LOOM_RUN_MODES",
    },
    {
      key: `roles.${name}.access`,
      section: "Access & safety" as const,
      label: `${name} access`,
      timing: "next-run" as const,
      environment: "LOOM_AGENT_ACCESS",
    },
  ]),
  {
    key: "workflow.requirePlanApproval",
    section: "Workflow & approvals",
    label: "Require plan approval",
    timing: "next-task",
  },
  {
    key: "workflow.size",
    section: "Workflow & approvals",
    label: "Default task size",
    timing: "next-task",
  },
  {
    key: "workflow.budgetMinutes",
    section: "Workflow & approvals",
    label: "Default budget",
    timing: "next-task",
  },
  {
    key: "workflow.reviewRoundCap",
    section: "Workflow & approvals",
    label: "Review round cap",
    timing: "next-task",
  },
  {
    key: "workflow.mergePolicy",
    section: "Workflow & approvals",
    label: "Merge mode",
    timing: "next-task",
  },
  {
    key: "operator.model",
    section: "Operator & Main",
    label: "Operator model",
    timing: "next-run",
    environment: "LOOM_MODEL_OPERATOR",
  },
  {
    key: "operator.leadModel",
    section: "Operator & Main",
    label: "Main model",
    timing: "next-run",
    environment: "LOOM_MODEL_LEAD",
  },
  {
    key: "operator.repoId",
    section: "Operator & Main",
    label: "Operator repository",
    timing: "next-run",
    environment: "LOOM_OPERATOR_REPO",
  },
  {
    key: "operator.autoFix",
    section: "Operator & Main",
    label: "Automatic fixes",
    timing: "immediate",
    environment: "LOOM_OPERATOR_AUTO_FIX",
  },
  {
    key: "operator.maxFiledPerHour",
    section: "Operator & Main",
    label: "Maximum filed per hour",
    timing: "immediate",
    environment: "LOOM_OPERATOR_MAX_FILED_PER_HOUR",
  },
  {
    key: "runtime.excludedAuthors",
    section: "GitHub",
    label: "Excluded authors",
    timing: "immediate",
    environment: "LOOM_EXCLUDED_AUTHORS",
  },
  {
    key: "appearance.theme",
    section: "Appearance",
    label: "Theme",
    timing: "immediate",
  },
  {
    key: "appearance.chime",
    section: "Appearance",
    label: "Completion chime",
    timing: "immediate",
  },
  {
    key: "appearance.windowMode",
    section: "Appearance",
    label: "Default window",
    timing: "restart-required",
    environment: "LOOM_WINDOW_MODE",
  },
  {
    key: "appearance.terminalHistoryLimit",
    section: "Terminals & keybindings",
    label: "Terminal history",
    timing: "next-run",
  },
  {
    key: "appearance.keyPrefix",
    section: "Terminals & keybindings",
    label: "Key prefix",
    timing: "immediate",
  },
  {
    key: "appearance.keyTimeoutMs",
    section: "Terminals & keybindings",
    label: "Key timeout",
    timing: "immediate",
  },
  ...(
    [
      "capTotal",
      "capCodex",
      "capClaude",
      "retryBaseMs",
      "retryCapMs",
      "retryMaxAttempts",
      "stallAfterMs",
      "unknownGraceMs",
      "deliveryTimeoutMs",
      "githubPollMs",
      "resyncMs",
      "heartbeatMs",
      "worktreeRoot",
      "tmuxExecutable",
      "codexExecutable",
      "claudeExecutable",
    ] as const
  ).map((key) => {
    const environment = (
      {
        capTotal: "LOOM_CAP_TOTAL",
        capCodex: "LOOM_CAP_CODEX",
        capClaude: "LOOM_CAP_CLAUDE",
        worktreeRoot: "LOOM_WORKTREE_ROOT",
        tmuxExecutable: "LOOM_TMUX",
        codexExecutable: "LOOM_CODEX",
        claudeExecutable: "LOOM_CLAUDE",
      } as Partial<Record<string, string>>
    )[key];
    return {
      key: `runtime.${key}`,
      section: "Advanced runtime" as const,
      label: key,
      timing: ([
        "worktreeRoot",
        "tmuxExecutable",
        "codexExecutable",
        "claudeExecutable",
        "heartbeatMs",
      ].includes(key)
        ? "restart-required"
        : "immediate") as ApplyTiming,
      ...(environment ? { environment } : {}),
    };
  }),
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const merge = (
  base: SettingsValues,
  patch?: SettingsPatch | null,
): SettingsValues => {
  if (!patch) return clone(base);
  return {
    roles: {
      ...base.roles,
      ...Object.fromEntries(
        Object.entries(patch.roles ?? {}).map(([k, v]) => [
          k,
          { ...base.roles[k as Role], ...v },
        ]),
      ),
    } as SettingsValues["roles"],
    workflow: { ...base.workflow, ...patch.workflow },
    operator: { ...base.operator, ...patch.operator },
    runtime: { ...base.runtime, ...patch.runtime },
    appearance: { ...base.appearance, ...patch.appearance },
  };
};

export function validateSettings(values: SettingsValues): string[] {
  const errors: string[] = [];
  for (const [name, profile] of Object.entries(values.roles) as [
    Role,
    RoleProfile,
  ][]) {
    const models: readonly string[] =
      MODEL_CATALOG.providers[profile.provider].models;
    if (!models.includes(profile.model))
      errors.push(
        `Unknown ${profile.provider} model for ${name}: ${profile.model}`,
      );
    if (profile.provider === "claude" && profile.reasoningEffort !== null)
      errors.push(`${name}: Claude does not accept a reasoning effort`);
    if (profile.provider === "codex" && profile.reasoningEffort === null)
      errors.push(`${name}: Codex requires a reasoning effort`);
    if (profile.access === "approval-gated" && profile.runMode === "headless")
      errors.push(`${name}: approval-gated access requires interactive mode`);
  }
  if (values.runtime.retryBaseMs > values.runtime.retryCapMs)
    errors.push("Retry base must not exceed retry cap");
  if (!values.runtime.worktreeRoot.startsWith("/"))
    errors.push("Worktree root must be an absolute path");
  for (const [key, value] of Object.entries(values.runtime))
    if (typeof value === "number" && (!Number.isInteger(value) || value <= 0))
      errors.push(`${key} must be a positive integer`);
  if (
    !Number.isInteger(values.workflow.reviewRoundCap) ||
    values.workflow.reviewRoundCap < 1
  )
    errors.push("Review round cap must be positive");
  if (
    values.workflow.budgetMinutes !== null &&
    (!Number.isInteger(values.workflow.budgetMinutes) ||
      values.workflow.budgetMinutes < 1)
  )
    errors.push("Budget must be null or a positive integer");
  if (
    !Number.isInteger(values.operator.maxFiledPerHour) ||
    values.operator.maxFiledPerHour < 1
  )
    errors.push("Maximum filed per hour must be positive");
  if (
    !Number.isInteger(values.appearance.terminalHistoryLimit) ||
    values.appearance.terminalHistoryLimit < 1 ||
    !Number.isInteger(values.appearance.keyTimeoutMs) ||
    values.appearance.keyTimeoutMs < 1
  )
    errors.push("Terminal history and key timeout must be positive");
  return errors;
}

export function resolveSettings(
  global: SettingsPatch | null,
  repository: SettingsPatch | null,
  environment: SettingsPatch | null,
) {
  const globalValues = merge(DEFAULT_SETTINGS, global);
  const repositoryValues = merge(globalValues, repository);
  const effective = merge(repositoryValues, environment);
  const sources: Record<string, SettingsSource> = {};
  for (const item of SETTINGS_CATALOG) {
    const [group = "", key = "", nested] = item.key.split(".");
    const has = (p: SettingsPatch | null) => {
      const section = (p as Record<string, unknown> | null)?.[group];
      if (!section || typeof section !== "object") return false;
      if (!nested) return Object.hasOwn(section, key);
      const child = (section as Record<string, unknown>)[key];
      return (
        !!child && typeof child === "object" && Object.hasOwn(child, nested)
      );
    };
    sources[item.key] = has(environment)
      ? "environment"
      : has(repository)
        ? "repository"
        : has(global)
          ? "global"
          : "default";
  }
  return { effective, sources };
}

export function mergeSettings(
  base: SettingsValues,
  patch: SettingsPatch,
): SettingsValues {
  return merge(base, patch);
}

/** Read a dotted catalog value without allowing arbitrary object traversal. */
export function settingValue(
  values: SettingsValues | SettingsPatch,
  path: string,
): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      values,
    );
}
