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
  repository: {
    baseBranch: string;
    serialTests: boolean;
  };
  operator: {
    policy: "v1";
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
    keyPrefix: string | null;
    keyTimeoutMs: number;
    keybindings: Record<string, string[]>;
  };
}

export type SettingsPatch = {
  roles?: Partial<Record<Role, Partial<RoleProfile>>>;
  workflow?: Partial<SettingsValues["workflow"]>;
  repository?: Partial<SettingsValues["repository"]>;
  operator?: Partial<SettingsValues["operator"]>;
  runtime?: Partial<SettingsValues["runtime"]>;
  appearance?: Partial<SettingsValues["appearance"]>;
};

export interface SettingDefinition {
  key: string;
  section:
    | "Agents & models"
    | "Workflow & approvals"
    | "Repositories"
    | "Access & safety"
    | "Operator & Main"
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
  repository: { baseBranch: "main", serialTests: false },
  operator: {
    policy: "v1",
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
    keyPrefix: "Ctrl+A",
    keyTimeoutMs: 3000,
    keybindings: {
      "split-right": ["Cmd+D", "Prefix |"],
      "split-down": ["Cmd+Shift+D", "Prefix -"],
      left: ["Cmd+Alt+ArrowLeft", "Prefix h"],
      down: ["Cmd+Alt+ArrowDown", "Prefix j"],
      up: ["Cmd+Alt+ArrowUp", "Prefix k"],
      right: ["Cmd+Alt+ArrowRight", "Prefix l"],
      new: ["Cmd+T", "Prefix c"],
      next: ["Cmd+Shift+]", "Prefix n"],
      previous: ["Cmd+Shift+[", "Prefix p"],
      close: ["Cmd+W", "Prefix x"],
      zoom: ["Cmd+Shift+Enter", "Prefix z"],
      jump: ["Cmd+P", "Prefix g"],
      help: ["Prefix ?"],
      commands: ["Cmd+K"],
      literal: ["Prefix Ctrl+A"],
    },
  },
};

const BOTH = ["global", "repository"] as const;
const GLOBAL = ["global"] as const;
const KEYBINDING_ACTIONS = [
  "split-right",
  "split-down",
  "left",
  "down",
  "up",
  "right",
  "new",
  "next",
  "previous",
  "close",
  "zoom",
  "jump",
  "help",
  "commands",
  "literal",
] as const;
const KEY_MODIFIERS = new Set(["Ctrl", "Cmd", "Alt", "Shift"]);
const NAMED_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Plus",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);
const validChord = (value: string) => {
  const parts = value.split("+");
  const key = parts.pop();
  return (
    !!key &&
    parts.every((part) => KEY_MODIFIERS.has(part)) &&
    new Set(parts).size === parts.length &&
    (/^[\x21-\x7e]$/.test(key) || NAMED_KEYS.has(key))
  );
};

export const SETTINGS_CATALOG: SettingDefinition[] = [
  ...(["planner", "implementer", "reviewer"] as Role[]).flatMap((name) => [
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
    key: "repository.serialTests",
    section: "Repositories",
    label: "Serialize tests",
    timing: "next-task",
    scopes: [...BOTH],
  },
  {
    key: "operator.policy",
    section: "Operator & Main",
    label: "Operator policy",
    timing: "restart-required",
    scopes: [...GLOBAL],
    readOnly: true,
  },
  {
    key: "operator.model",
    section: "Operator & Main",
    label: "Operator model",
    timing: "next-run",
    environment: "LOOM_MODEL_OPERATOR",
    scopes: [...GLOBAL],
  },
  {
    key: "operator.leadModel",
    section: "Operator & Main",
    label: "Main model",
    timing: "next-run",
    environment: "LOOM_MODEL_LEAD",
    scopes: [...GLOBAL],
  },
  {
    key: "operator.repoId",
    section: "Operator & Main",
    label: "Operator repository",
    timing: "next-run",
    environment: "LOOM_OPERATOR_REPO",
    scopes: [...GLOBAL],
  },
  {
    key: "operator.autoFix",
    section: "Operator & Main",
    label: "Automatic fixes",
    timing: "immediate",
    environment: "LOOM_OPERATOR_AUTO_FIX",
    scopes: [...GLOBAL],
  },
  {
    key: "operator.maxFiledPerHour",
    section: "Operator & Main",
    label: "Maximum filed per hour",
    timing: "immediate",
    environment: "LOOM_OPERATOR_MAX_FILED_PER_HOUR",
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
  if (!values.repository.baseBranch.trim())
    errors.push("Base branch is required");
  if (values.operator.policy !== "v1") errors.push("Unknown Operator policy");
  if (
    values.appearance.keyPrefix !== null &&
    !values.appearance.keyPrefix.trim()
  )
    errors.push("Key prefix must be null or non-empty");
  if (
    values.appearance.keyPrefix !== null &&
    !validChord(values.appearance.keyPrefix)
  )
    errors.push("Key prefix must be a valid chord");
  const actions = Object.keys(values.appearance.keybindings);
  if (
    actions.length !== KEYBINDING_ACTIONS.length ||
    KEYBINDING_ACTIONS.some((action) => !actions.includes(action))
  )
    errors.push("Key bindings must define every supported action exactly once");
  const seenBindings = new Set<string>();
  for (const [action, bindings] of Object.entries(
    values.appearance.keybindings,
  )) {
    if (
      !action ||
      !Array.isArray(bindings) ||
      bindings.some((item) => !item.trim())
    )
      errors.push(`Invalid key bindings for ${action}`);
    for (const binding of bindings) {
      const prefixed = binding.startsWith("Prefix ");
      const chord = prefixed ? binding.slice(7) : binding;
      if (!validChord(chord)) errors.push(`Invalid key binding: ${binding}`);
      if (prefixed && values.appearance.keyPrefix === null)
        errors.push(`Prefix binding needs a prefix: ${binding}`);
      const identity = `${prefixed}:${chord}`;
      if (seenBindings.has(identity))
        errors.push(`Duplicate key binding: ${binding}`);
      seenBindings.add(identity);
    }
  }
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
  defaults: SettingsValues = DEFAULT_SETTINGS,
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
