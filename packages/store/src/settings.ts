import type { SettingsPatch, SettingsScope } from "@loom/core";
import type Database from "better-sqlite3";
import { z } from "zod";

const rowSchema = z.object({
  version: z.number().int().nonnegative(),
  data: z.string(),
  updated_at: z.string(),
});
const auditSchema = z.object({
  id: z.number().int(),
  scope: z.enum(["global", "repository"]),
  repo_id: z.string().nullable(),
  actor: z.string(),
  changed_at: z.string(),
  setting_key: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  settings_version: z.number().int(),
});
export interface StoredSettings {
  scope: SettingsScope;
  version: number;
  data: SettingsPatch;
  updatedAt: string | null;
}
export interface SettingsAudit {
  id: number;
  scope: SettingsScope;
  actor: string;
  changedAt: string;
  settingKey: string;
  oldValue: unknown;
  newValue: unknown;
  settingsVersion: number;
}

const parts = (scope: SettingsScope): [string, string] =>
  scope.kind === "global" ? ["global", ""] : ["repository", scope.repoId];
const parseJson = (text: string): SettingsPatch =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(text)) as SettingsPatch;
const safeValue = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);
const secretName = /(secret|token|password|credential|api[_-]?key)/i;
const assertNoSecrets = (value: unknown, path = "settings"): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (secretName.test(key))
      throw new Error(`Secret-bearing setting is forbidden: ${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
};

export class SettingsStore {
  constructor(private readonly db: Database.Database) {}
  read(scope: SettingsScope): StoredSettings {
    const [kind, repoId] = parts(scope);
    const raw = this.db
      .prepare(
        "SELECT version, data, updated_at FROM settings WHERE scope = ? AND repo_id = ?",
      )
      .get(kind, repoId);
    if (!raw) return { scope, version: 0, data: {}, updatedAt: null };
    const row = rowSchema.parse(raw);
    return {
      scope,
      version: row.version,
      data: parseJson(row.data),
      updatedAt: row.updated_at,
    };
  }
  update(input: {
    scope: SettingsScope;
    expectedVersion: number;
    data: SettingsPatch;
    actor: string;
    changedAt: string;
    changes: { key: string; oldValue: unknown; newValue: unknown }[];
  }): StoredSettings {
    assertNoSecrets(input.data);
    for (const change of input.changes) {
      if (secretName.test(change.key))
        throw new Error("Secret-bearing audit key is forbidden");
      assertNoSecrets(change.oldValue, "audit.oldValue");
      assertNoSecrets(change.newValue, "audit.newValue");
    }
    const [kind, repoId] = parts(input.scope);
    return this.db
      .transaction(() => {
        const current = this.read(input.scope);
        if (current.version !== input.expectedVersion)
          throw Object.assign(
            new Error(
              `Settings changed in another window (expected ${input.expectedVersion}, current ${current.version})`,
            ),
            { code: "conflict" },
          );
        const version = current.version + 1;
        this.db
          .prepare(
            "INSERT INTO settings(scope, repo_id, version, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, repo_id) DO UPDATE SET version=excluded.version, data=excluded.data, updated_at=excluded.updated_at",
          )
          .run(
            kind,
            repoId,
            version,
            JSON.stringify(input.data),
            input.changedAt,
          );
        const insert = this.db.prepare(
          "INSERT INTO settings_audit(scope, repo_id, actor, changed_at, setting_key, old_value, new_value, settings_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const change of input.changes)
          insert.run(
            kind,
            repoId,
            input.actor,
            input.changedAt,
            change.key,
            safeValue(change.oldValue),
            safeValue(change.newValue),
            version,
          );
        return {
          scope: input.scope,
          version,
          data: input.data,
          updatedAt: input.changedAt,
        };
      })
      .immediate();
  }
  audit(limit = 100): SettingsAudit[] {
    return this.db
      .prepare("SELECT * FROM settings_audit ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((raw) => {
        const row = auditSchema.parse(raw);
        return {
          id: row.id,
          scope:
            row.scope === "global"
              ? { kind: "global" }
              : { kind: "repository", repoId: row.repo_id ?? "" },
          actor: row.actor,
          changedAt: row.changed_at,
          settingKey: row.setting_key,
          oldValue:
            row.old_value === null ? undefined : JSON.parse(row.old_value),
          newValue:
            row.new_value === null ? undefined : JSON.parse(row.new_value),
          settingsVersion: row.settings_version,
        };
      });
  }
}
