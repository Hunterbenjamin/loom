import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { z } from "zod";

export interface Migration {
  version: number;
  name: string;
  breaking: boolean;
  sql: string;
}
export const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
export function readMigrations(directory = migrationsDirectory): Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name, index) => {
      const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
      if (!match || Number(match[1]) !== index + 1)
        throw new Error(`Non-sequential migration: ${name}`);
      const sql = readFileSync(join(directory, name), "utf8");
      return {
        version: index + 1,
        name,
        sql,
        breaking: /^--\s*breaking\s*$/im.test(sql),
      };
    });
}
function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}
export function schemaVersion(db: Database.Database): number {
  if (!hasTable(db, "meta")) return 0;
  return z.coerce
    .number()
    .int()
    .nonnegative()
    .parse(
      db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .pluck()
        .get(),
    );
}
function checkCompatibility(
  db: Database.Database,
  migrations: Migration[],
): void {
  if (!hasTable(db, "schema_migrations")) return;
  const applied = z
    .array(
      z.object({
        version: z.number().int(),
        breaking: z.number().int(),
        name: z.string(),
      }),
    )
    .parse(
      db.prepare("SELECT version, breaking, name FROM schema_migrations").all(),
    );
  for (const row of applied) {
    if (
      row.breaking &&
      !migrations.some(
        (m) => m.version === row.version && m.name === row.name && m.breaking,
      )
    ) {
      throw new Error(`Unknown breaking migration: ${row.name}`);
    }
  }
}
/** Call at startup before exposing this connection. SQLite's backup API includes committed WAL pages. */
export async function migrate(
  db: Database.Database,
  backupDirectory: string,
  migrations = readMigrations(),
): Promise<string[]> {
  checkCompatibility(db, migrations);
  const pending = migrations.filter((m) => m.version > schemaVersion(db));
  const backups: string[] = [];
  if (pending.length) {
    mkdirSync(backupDirectory, { recursive: true });
    const path = join(
      backupDirectory,
      `before-v${pending[0]?.version}-${randomUUID()}.sqlite`,
    );
    await db.backup(path);
    backups.push(path);
  }
  for (const migration of pending) {
    db.transaction(() => {
      checkCompatibility(db, migrations);
      // Another opener may have migrated while the asynchronous backup ran.
      if (schemaVersion(db) >= migration.version) return;
      if (schemaVersion(db) !== migration.version - 1)
        throw new Error("Migration version gap");
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations(version, name, breaking) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, Number(migration.breaking));
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(migration.version),
      );
    }).immediate();
  }
  return backups;
}
