import type { IsoTime, RepoId, SettingsScope } from "@loom/core";
import {
  DEFAULT_SETTINGS,
  MODEL_CATALOG,
  resolveSettings,
  SETTINGS_CATALOG,
  type SettingsPatch,
  type SettingsValues,
  settingValue,
  validateSettings,
} from "@loom/core";
import type { Store } from "@loom/store";
import type { CommandOf, Handlers } from "./commands.js";
import type { CoordinatorConfig } from "./config.js";
import type { Row } from "./views.js";

const settingsId = (scope: SettingsScope): string =>
  scope.kind === "global" ? "global" : `repo:${scope.repoId}`;

const mergeStored = (
  current: SettingsPatch,
  patch: SettingsPatch,
): SettingsPatch => ({
  ...current,
  ...patch,
  ...(patch.roles
    ? {
        roles: Object.fromEntries(
          Object.entries({ ...current.roles, ...patch.roles }).map(
            ([role, value]) => [
              role,
              {
                ...current.roles?.[
                  role as keyof NonNullable<SettingsPatch["roles"]>
                ],
                ...value,
              },
            ],
          ),
        ),
      }
    : {}),
  ...(patch.workflow
    ? { workflow: { ...current.workflow, ...patch.workflow } }
    : {}),
  ...(patch.repository
    ? { repository: { ...current.repository, ...patch.repository } }
    : {}),
  ...(patch.research
    ? { research: { ...current.research, ...patch.research } }
    : {}),
  ...(patch.main ? { main: { ...current.main, ...patch.main } } : {}),
  ...(patch.runtime
    ? { runtime: { ...current.runtime, ...patch.runtime } }
    : {}),
  ...(patch.appearance
    ? { appearance: { ...current.appearance, ...patch.appearance } }
    : {}),
});

const removeSettings = (
  current: SettingsPatch,
  keys: readonly string[],
): SettingsPatch => {
  const next = structuredClone(current) as Record<string, unknown>;
  for (const path of keys) {
    const parts = path.split(".");
    let parent: Record<string, unknown> | undefined = next;
    for (const part of parts.slice(0, -1)) {
      const child: unknown = parent?.[part];
      parent =
        child && typeof child === "object"
          ? (child as Record<string, unknown>)
          : undefined;
    }
    if (parent) delete parent[parts.at(-1) ?? ""];
  }
  return next as SettingsPatch;
};

const changedSettings = (before: SettingsPatch, after: SettingsPatch) =>
  SETTINGS_CATALOG.flatMap(({ key }) => {
    const oldValue = settingValue(before, key);
    const newValue = settingValue(after, key);
    return JSON.stringify(oldValue) === JSON.stringify(newValue)
      ? []
      : [{ key, oldValue, newValue }];
  });

interface SettingsDeps {
  store: Store;
  config: CoordinatorConfig;
  now(): IsoTime;
  onGlobalSaved(): void;
  publish(): void;
}

type SettingsKind = "update_settings" | "reset_settings";

export class CoordinatorSettings {
  constructor(private readonly deps: SettingsDeps) {}

  effective(repoId?: RepoId | string): SettingsValues {
    const global = this.deps.store.settings.read({ kind: "global" }).data;
    const repository = repoId
      ? this.deps.store.settings.read({ kind: "repository", repoId }).data
      : null;
    return resolveSettings(
      global,
      repository,
      this.deps.config.settingsEnvironment,
      DEFAULT_SETTINGS,
      this.deps.config.providerEnvironment,
    ).effective;
  }

  rows(): Row[] {
    const global = this.deps.store.settings.read({ kind: "global" });
    const audit = this.deps.store.settings.audit(100);
    const scopes: SettingsScope[] = [
      { kind: "global" },
      ...this.deps.store
        .repos()
        .map((repo) => ({ kind: "repository" as const, repoId: repo.id })),
    ];
    return scopes.map((scope) => {
      const stored =
        scope.kind === "global" ? global : this.deps.store.settings.read(scope);
      const resolution = resolveSettings(
        global.data,
        scope.kind === "repository" ? stored.data : null,
        this.deps.config.settingsEnvironment,
        DEFAULT_SETTINGS,
        this.deps.config.providerEnvironment,
      );
      return {
        collection: "settings" as const,
        key: settingsId(scope),
        value: {
          id: settingsId(scope),
          scope,
          version: stored.version,
          stored: stored.data,
          defaults: DEFAULT_SETTINGS,
          effective: resolution.effective,
          sources: resolution.sources,
          catalog: SETTINGS_CATALOG,
          modelCatalog: MODEL_CATALOG,
          credentialReadiness: {
            codex: Boolean(
              process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
            ),
            claude: Boolean(process.env.ANTHROPIC_API_KEY),
            github: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
          },
          audit: audit.filter(
            (entry) => settingsId(entry.scope) === settingsId(scope),
          ),
        },
      };
    });
  }

  handlers(): Handlers<SettingsKind> {
    return {
      update_settings: (command) => this.update(command),
      reset_settings: (command) => this.reset(command),
    };
  }

  private update(command: CommandOf<"update_settings">) {
    const current = this.deps.store.settings.read(command.scope);
    const version = this.save(
      command.scope,
      command.expectedVersion,
      mergeStored(current.data, command.patch),
    );
    return {
      ok: true as const,
      result: { kind: "settings_updated", scope: command.scope, version },
    };
  }

  private reset(command: CommandOf<"reset_settings">) {
    const known = new Set(SETTINGS_CATALOG.map((item) => item.key));
    const unknown = command.keys.filter((key) => !known.has(key));
    if (unknown.length)
      throw Object.assign(new Error("Unknown setting key"), {
        code: "invalid_input",
        details: unknown,
      });
    const current = this.deps.store.settings.read(command.scope);
    const version = this.save(
      command.scope,
      command.expectedVersion,
      removeSettings(current.data, command.keys),
    );
    return {
      ok: true as const,
      result: { kind: "settings_updated", scope: command.scope, version },
    };
  }

  private save(
    scope: SettingsScope,
    expectedVersion: number,
    next: SettingsPatch,
  ): number {
    if (
      scope.kind === "repository" &&
      !this.deps.store.repos().some((repo) => repo.id === scope.repoId)
    )
      throw Object.assign(new Error("Unknown registered repository"), {
        code: "invalid_input",
      });
    const current = this.deps.store.settings.read(scope);
    const changes = changedSettings(current.data, next);
    if (!changes.length)
      throw Object.assign(new Error("No settings changed"), {
        code: "invalid_input",
      });
    const unavailable = changes
      .map((change) => SETTINGS_CATALOG.find((item) => item.key === change.key))
      .filter(
        (item) => !item || item.readOnly || !item.scopes.includes(scope.kind),
      );
    if (unavailable.length)
      throw Object.assign(new Error("Setting is not editable in this scope"), {
        code: "invalid_input",
        details: unavailable.map((item) => item?.key ?? "unknown setting"),
      });
    const global =
      scope.kind === "global"
        ? next
        : this.deps.store.settings.read({ kind: "global" }).data;
    const repositories =
      scope.kind === "repository"
        ? [{ id: scope.repoId, data: next }]
        : this.deps.store.repos().map((repo) => ({
            id: repo.id,
            data: this.deps.store.settings.read({
              kind: "repository",
              repoId: repo.id,
            }).data,
          }));
    const validateResolved = (
      repositoryData: SettingsPatch | null,
      environment: SettingsPatch | null,
    ) => {
      const effective = resolveSettings(
        global,
        repositoryData,
        environment,
        DEFAULT_SETTINGS,
        this.deps.config.providerEnvironment,
      ).effective;
      return validateSettings(effective);
    };
    const errors = [
      ...validateResolved(null, null),
      ...validateResolved(null, this.deps.config.settingsEnvironment),
      ...repositories.flatMap((repo) =>
        [
          ...validateResolved(repo.data, null),
          ...validateResolved(repo.data, this.deps.config.settingsEnvironment),
        ].map((message) => `${repo.id}: ${message}`),
      ),
    ];
    if (errors.length)
      throw Object.assign(new Error("Settings validation failed"), {
        code: "invalid_input",
        details: errors,
      });
    const saved = this.deps.store.settings.update({
      scope,
      expectedVersion,
      data: next,
      actor: "desktop",
      changedAt: this.deps.now(),
      changes,
    });
    if (scope.kind === "global") this.deps.onGlobalSaved();
    this.deps.publish();
    return saved.version;
  }
}
