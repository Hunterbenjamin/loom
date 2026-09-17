import type { Provider, Role, RunMode, TaskSize } from "./entities.js";
import { ROLE_VALUES } from "./entities.js";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  parseChord,
  validateKeybindings,
} from "./keybindings.js";
import type { ResearchDepth } from "./research.js";

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
export const MERGE_POLICY_VALUES = [
  "require-human",
  "auto-small",
  "auto-all",
] as const;
export type MergePolicy = (typeof MERGE_POLICY_VALUES)[number];
export const ACCESS_PRESET_VALUES = ["full", "approval-gated"] as const;
export type AccessPreset = (typeof ACCESS_PRESET_VALUES)[number];
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export interface RoleProfile {
  provider: Provider;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  runMode: RunMode;
  access: AccessPreset;
}

export interface SettingsValues {
  roles: Record<Role, RoleProfile>;
  research: Pick<RoleProfile, "provider" | "model" | "reasoningEffort"> & {
    depth: ResearchDepth;
  };
  workflow: {
    requirePlanApproval: boolean;
    size: TaskSize;
    budgetMinutes: number | null;
    reviewRoundCap: number;
    mergePolicy: MergePolicy;
  };
  repository: {
    baseBranch: string;
  };
  main: { model: string | null };
  runtime: {
    capTotal: number;
    capCodex: number;
    capClaude: number;
    retryBaseMs: number;
    retryCapMs: number;
    retryMaxAttempts: number;
    stallAfterMs: number;
    fixRoundStallAfterMs: number;
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
    keyPrefix: string | null;
    keyTimeoutMs: number | null;
    keybindings: Record<string, string[]>;
  };
}

export type SettingsPatch = {
  roles?: Partial<Record<Role, Partial<RoleProfile>>>;
  research?: Partial<SettingsValues["research"]>;
  workflow?: Partial<SettingsValues["workflow"]>;
  repository?: Partial<SettingsValues["repository"]>;
  main?: Partial<SettingsValues["main"]>;
  runtime?: Partial<SettingsValues["runtime"]>;
  appearance?: Partial<SettingsValues["appearance"]>;
};

/** Provider-wide environment values are applied after the effective role provider is known. */
export interface ProviderEnvironmentSettings {
  models?: Partial<Record<Provider, string>>;
  codexReasoningEffort?: ReasoningEffort;
}

export interface SettingDefinition {
  key: string;
  section:
    | "Agents & models"
    | "Workflow & approvals"
    | "Repositories"
    | "Access & safety"
    | "Main"
    | "Terminals & keybindings"
    | "GitHub"
    | "Appearance"
    | "Advanced runtime";
  label: string;
  timing: ApplyTiming;
  environment?: string;
  scopes: ("global" | "repository")[];
  readOnly?: boolean;
}

const codexModels = [
  "gpt-5.1-codex",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.3-codex-spark",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-6-astra",
];
const claudeModels = [
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
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
  repository: { baseBranch: "main" },
  main: { model: null },
  research: {
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    depth: "standard",
  },
  runtime: {
    capTotal: 4,
    capCodex: 3,
    capClaude: 3,
    retryBaseMs: 10_000,
    retryCapMs: 300_000,
    retryMaxAttempts: 3,
    stallAfterMs: 900_000,
    fixRoundStallAfterMs: 300_000,
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
    keyPrefix: DEFAULT_KEYBINDINGS.prefix,
    keyTimeoutMs: DEFAULT_KEYBINDINGS.prefixTimeoutMs,
    keybindings: DEFAULT_KEYBINDINGS.bindings,
  },
};

const BOTH = ["global", "repository"] as const;
const GLOBAL = ["global"] as const;
export const SETTINGS_CATALOG: SettingDefinition[] = [
  ...["provider", "model", "reasoningEffort", "depth"].map((key) => ({
    key: `research.${key}`,
    section: "Agents & models" as const,
    label: `Research ${key}`,
    timing: "next-run" as const,
    scopes: [...GLOBAL],
  })),
  ...([...ROLE_VALUES] as Role[]).flatMap((name) => [
    {
      key: `roles.${name}.provider`,
      section: "Agents & models" as const,
      label: `${name} provider`,
      timing: "next-run" as const,
      environment: `LOOM_PROVIDER_${name.toUpperCase()}`,
      scopes: [...BOTH],
    },
    {
      key: `roles.${name}.model`,
      section: "Agents & models" as const,
      label: `${name} model`,
      timing: "next-run" as const,
      environment: "LOOM_MODEL_CODEX / LOOM_MODEL_CLAUDE",
      scopes: [...BOTH],
    },
    {
      key: `roles.${name}.reasoningEffort`,
      section: "Agents & models" as const,
      label: `${name} reasoning`,
      timing: "next-run" as const,
      environment: "LOOM_CODEX_REASONING_EFFORT",
      scopes: [...BOTH],
    },
    {
      key: `roles.${name}.runMode`,
      section: "Agents & models" as const,
      label: `${name} run mode`,
      timing: "next-run" as const,
      environment: "LOOM_RUN_MODES",
      scopes: [...BOTH],
    },
    {
      key: `roles.${name}.access`,
      section: "Access & safety" as const,
      label: `${name} access`,
      timing: "next-run" as const,
      environment: "LOOM_AGENT_ACCESS",
      scopes: [...BOTH],
    },
  ]),
  {
    key: "workflow.requirePlanApproval",
    section: "Workflow & approvals",
    label: "Require plan approval",
    timing: "next-task",
    scopes: [...BOTH],
  },
  {
    key: "workflow.size",
    section: "Workflow & approvals",
    label: "Default task size",
    timing: "next-task",
    scopes: [...BOTH],
  },
  {
    key: "workflow.budgetMinutes",
    section: "Workflow & approvals",
    label: "Default budget",
    timing: "next-task",
    scopes: [...BOTH],
  },
  {
    key: "workflow.reviewRoundCap",
    section: "Workflow & approvals",
    label: "Review round cap",
    timing: "next-task",
    scopes: [...BOTH],
  },
  {
    key: "workflow.mergePolicy",
    section: "Workflow & approvals",
    label: "Merge mode",
    timing: "next-task",
    scopes: [...BOTH],
  },
  {
    key: "repository.baseBranch",
    section: "Repositories",
    label: "Base branch",
    timing: "next-task",
    scopes: [...BOTH],
    environment: "LOOM_BASE_BRANCH",
  },
  {
    key: "main.model",
    section: "Main",
    label: "Main model",
    timing: "next-run",
    environment: "LOOM_MODEL_LEAD",
    scopes: [...GLOBAL],
  },
  {
    key: "runtime.excludedAuthors",
    section: "GitHub",
    label: "Excluded authors",
    timing: "immediate",
    environment: "LOOM_EXCLUDED_AUTHORS",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.theme",
    section: "Appearance",
    label: "Theme",
    timing: "immediate",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.chime",
    section: "Appearance",
    label: "Completion chime",
    timing: "immediate",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.windowMode",
    section: "Appearance",
    label: "Default window",
    timing: "restart-required",
    environment: "LOOM_WINDOW_MODE",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.terminalHistoryLimit",
    section: "Terminals & keybindings",
    label: "Terminal history",
    timing: "next-run",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.keyPrefix",
    section: "Terminals & keybindings",
    label: "Key prefix",
    timing: "immediate",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.keyTimeoutMs",
    section: "Terminals & keybindings",
    label: "Key timeout",
    timing: "immediate",
    scopes: [...GLOBAL],
  },
  {
    key: "appearance.keybindings",
    section: "Terminals & keybindings",
    label: "Key bindings",
    timing: "immediate",
    scopes: [...GLOBAL],
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
      "fixRoundStallAfterMs",
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
      scopes: [...GLOBAL],
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
    repository: { ...base.repository, ...patch.repository },
    main: { ...base.main, ...patch.main },
    research: { ...base.research, ...patch.research },
    runtime: { ...base.runtime, ...patch.runtime },
    appearance: {
      ...base.appearance,
      ...patch.appearance,
      keybindings: {
        ...base.appearance.keybindings,
        ...patch.appearance?.keybindings,
      },
    },
  };
};

export function validateSettings(values: SettingsValues): string[] {
  const errors: string[] = [];
  for (const [name, profile] of Object.entries({
    ...values.roles,
    research: values.research,
  })) {
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
    if (
      "access" in profile &&
      profile.access === "approval-gated" &&
      profile.runMode === "headless"
    )
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
  if (!values.repository.baseBranch.trim())
    errors.push("Base branch is required");
  if (
    values.appearance.keyPrefix !== null &&
    !values.appearance.keyPrefix.trim()
  )
    errors.push("Key prefix must be null or non-empty");
  if (
    values.appearance.keyPrefix !== null &&
    parseChord(values.appearance.keyPrefix) === null
  )
    errors.push("Key prefix must be a valid chord");
  const actions = Object.keys(values.appearance.keybindings);
  if (
    actions.length !== KEYBINDING_ACTIONS.length ||
    KEYBINDING_ACTIONS.some(({ id }) => !actions.includes(id))
  )
    errors.push("Key bindings must define every supported action exactly once");
  errors.push(
    ...validateKeybindings({
      prefix: values.appearance.keyPrefix,
      bindings: values.appearance.keybindings,
    }).map((issue) => issue.message),
  );
  if (
    !Number.isInteger(values.appearance.terminalHistoryLimit) ||
    values.appearance.terminalHistoryLimit < 1 ||
    (values.appearance.keyTimeoutMs !== null &&
      (!Number.isInteger(values.appearance.keyTimeoutMs) ||
        values.appearance.keyTimeoutMs < 100 ||
        values.appearance.keyTimeoutMs > 60000))
  )
    errors.push(
      "Terminal history must be positive; key timeout must be null or 100–60000 ms",
    );
  return errors;
}

export function resolveSettings(
  global: SettingsPatch | null,
  repository: SettingsPatch | null,
  environment: SettingsPatch | null,
  defaults: SettingsValues = DEFAULT_SETTINGS,
  providerEnvironment: ProviderEnvironmentSettings | null = null,
) {
  const globalValues = merge(defaults, global);
  const repositoryValues = merge(globalValues, repository);
  const effective = merge(repositoryValues, environment);
  const sources: Record<string, SettingsSource> = {};
  for (const item of SETTINGS_CATALOG) {
    const has = (p: SettingsPatch | null) =>
      settingValue(p ?? {}, item.key) !== undefined;
    sources[item.key] = has(environment)
      ? "environment"
      : has(repository)
        ? "repository"
        : has(global)
          ? "global"
          : "default";
  }
  for (const role of [...ROLE_VALUES]) {
    const profile = effective.roles[role];
    const model = providerEnvironment?.models?.[profile.provider];
    if (model !== undefined) {
      profile.model = model;
      sources[`roles.${role}.model`] = "environment";
    }
    if (
      profile.provider === "codex" &&
      providerEnvironment?.codexReasoningEffort !== undefined
    ) {
      profile.reasoningEffort = providerEnvironment.codexReasoningEffort;
      sources[`roles.${role}.reasoningEffort`] = "environment";
    }
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
