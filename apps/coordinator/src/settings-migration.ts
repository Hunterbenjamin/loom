import {
  DEFAULT_SETTINGS,
  mergeSettings,
  resolveSettings,
  SETTINGS_CATALOG,
  settingValue,
  type ProviderRules,
  type SettingsPatch,
  type SettingsScope,
  type SettingsValues,
} from "@loom/core";
import type { Store } from "@loom/store";
import type { CoordinatorConfig } from "./config.js";

export interface LegacyRepositorySettings {
  baseBranch?: string;
  defaultProviders?: Partial<ProviderRules>;
  serialTests?: boolean;
}

/** Frozen copy of the pre-migration compatibility defaults. Do not use for runtime resolution. */
export function legacySettingsDefaults(
  config: CoordinatorConfig,
  repo?: LegacyRepositorySettings,
): SettingsValues {
  let defaults = mergeSettings(DEFAULT_SETTINGS, {
    repository: {
      baseBranch: repo?.baseBranch ?? config.baseBranch,
      serialTests: repo?.serialTests ?? false,
    },
  });
  for (const role of ["planner", "implementer", "reviewer"] as const) {
    const provider =
      config.providerOverrides[role] ??
      repo?.defaultProviders?.[role] ??
      defaults.roles[role].provider;
    defaults = mergeSettings(defaults, {
      roles: {
        [role]: {
          provider,
          model: config.models[provider],
          reasoningEffort:
            provider === "codex"
              ? (config.codexReasoningEffort ?? "medium")
              : null,
          runMode: config.runModes[role] ?? "interactive",
          access: config.agentAccess,
        },
      },
    });
  }
  return defaults;
}

const setSetting = (
  patch: SettingsPatch,
  path: string,
  value: unknown,
): void => {
  const parts = path.split(".");
  let parent = patch as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const child = parent[part];
    if (!child || typeof child !== "object") parent[part] = {};
    parent = parent[part] as Record<string, unknown>;
  }
  parent[parts.at(-1) as string] = value;
};

const migrationUpdate = (
  store: Store,
  scope: SettingsScope,
  oldEffective: SettingsValues,
  newEffective: SettingsValues,
  changedAt: string,
): Parameters<Store["settings"]["update"]>[0] | undefined => {
  const current = store.settings.read(scope);
  const data = structuredClone(current.data);
  for (const { key } of SETTINGS_CATALOG) {
    const oldValue = settingValue(oldEffective, key);
    const newValue = settingValue(newEffective, key);
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
      setSetting(data, key, oldValue);
  }
  const changes = SETTINGS_CATALOG.flatMap(({ key }) => {
    const oldValue = settingValue(current.data, key);
    const newValue = settingValue(data, key);
    return JSON.stringify(oldValue) === JSON.stringify(newValue)
      ? []
      : [{ key, oldValue, newValue }];
  });
  return changes.length
    ? {
        scope,
        expectedVersion: current.version,
        data,
        actor: "migration",
        changedAt,
        changes,
      }
    : undefined;
};

/** Preserve resolved values, then remove the legacy repo-row owners. Safe to rerun. */
export function migrateSettings(
  store: Store,
  config: CoordinatorConfig,
  changedAt: string,
): void {
  const globalScope = { kind: "global" } as const;
  const global = store.settings.read(globalScope).data;
  const legacyRepositories = store.legacyRepoSettings();
  const oldGlobal = resolveSettings(
    global,
    null,
    config.settingsEnvironment,
    legacySettingsDefaults(config),
    config.providerEnvironment,
  ).effective;
  const newGlobal = resolveSettings(
    global,
    null,
    config.settingsEnvironment,
    DEFAULT_SETTINGS,
    config.providerEnvironment,
  ).effective;
  const globalUpdate = migrationUpdate(
    store,
    globalScope,
    oldGlobal,
    newGlobal,
    changedAt,
  );
  const migratedGlobal = globalUpdate?.data ?? global;
  const repositories = legacyRepositories.map((legacy) => {
    const scope = {
      kind: "repository" as const,
      repoId: legacy.repo.id,
    };
    const repository = store.settings.read(scope).data;
    const oldEffective = resolveSettings(
      global,
      repository,
      config.settingsEnvironment,
      legacySettingsDefaults(config, legacy),
      config.providerEnvironment,
    ).effective;
    const newEffective = resolveSettings(
      migratedGlobal,
      repository,
      config.settingsEnvironment,
      DEFAULT_SETTINGS,
      config.providerEnvironment,
    ).effective;
    return {
      repoId: legacy.repo.id,
      update: migrationUpdate(
        store,
        scope,
        oldEffective,
        newEffective,
        changedAt,
      ),
    };
  });
  if (globalUpdate || repositories.length)
    store.migrateLegacySettings(globalUpdate, repositories);
}
