import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  resolveSettings,
  type RepoId,
  type WorktreePath,
} from "@loom/core";
import { openStore } from "@loom/store";
import { afterEach, expect, test } from "vitest";
import { configSchema, reconcileConfig } from "./config.js";
import { legacySettingsDefaults, migrateSettings } from "./settings-migration.js";

const Database = createRequire(
  new URL("../../../packages/store/package.json", import.meta.url),
)("better-sqlite3") as new (path: string) => {
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    pluck(): { get(...values: unknown[]): unknown };
    run(...values: unknown[]): unknown;
  };
  close(): void;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("moves legacy compatibility values into settings exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-settings-migration-"));
  roots.push(root);
  const config = configSchema.parse({
    instance: "test",
    dataRoot: root,
    worktreeRoot: join(root, "worktrees"),
    baseBranch: "trunk",
    bind: "127.0.0.1:0",
    token: "migration-test-token-0123456789",
    models: { codex: "gpt-5.6-sol", claude: "claude-opus-4-6" },
    runModes: "reviewer=headless",
  });
  const store = await openStore({
    dataRoot: root,
    instance: "test",
    config: reconcileConfig(config),
  });
  const repo = {
    id: "legacy-repo" as RepoId,
    root: join(root, "repo") as WorktreePath,
    github: "example/legacy",
  };
  store.putRepo(repo);
  const sqlite = new Database(join(root, "test", "loom.sqlite"));
  const raw = JSON.parse(
    sqlite
      .prepare("SELECT data FROM repos WHERE id = ?")
      .pluck()
      .get(repo.id) as string,
  ) as Record<string, unknown>;
  sqlite
    .prepare("UPDATE repos SET data = ? WHERE id = ?")
    .run(
      JSON.stringify({
        ...raw,
        baseBranch: "release",
        defaultProviders: {
          planner: "claude",
          implementer: "claude",
          reviewer: "codex",
        },
        serialTests: true,
      }),
      repo.id,
    );
  sqlite.close();
  store.settings.update({
    scope: { kind: "global" },
    expectedVersion: 0,
    data: {
      roles: { implementer: { provider: "codex" } },
      workflow: { size: "small" },
    },
    actor: "test",
    changedAt: "2026-09-15T00:00:00.000Z",
    changes: [],
  });

  const global = store.settings.read({ kind: "global" }).data;
  const repository = store.settings.read({
    kind: "repository",
    repoId: repo.id,
  }).data;
  const legacy = store.legacyRepoSettings()[0];
  if (!legacy) throw new Error("legacy row missing");
  const oldGlobal = resolveSettings(
    global,
    null,
    config.settingsEnvironment,
    legacySettingsDefaults(config),
    config.providerEnvironment,
  ).effective;
  const oldRepository = resolveSettings(
    global,
    repository,
    config.settingsEnvironment,
    legacySettingsDefaults(config, legacy),
    config.providerEnvironment,
  ).effective;

  migrateSettings(store, config, "2026-09-15T01:00:00.000Z");
  const migratedGlobal = store.settings.read({ kind: "global" }).data;
  const migratedRepository = store.settings.read({
    kind: "repository",
    repoId: repo.id,
  }).data;
  expect(
    resolveSettings(
      migratedGlobal,
      null,
      config.settingsEnvironment,
      DEFAULT_SETTINGS,
      config.providerEnvironment,
    ).effective,
  ).toEqual(oldGlobal);
  expect(
    resolveSettings(
      migratedGlobal,
      migratedRepository,
      config.settingsEnvironment,
      DEFAULT_SETTINGS,
      config.providerEnvironment,
    ).effective,
  ).toEqual(oldRepository);
  expect(store.legacyRepoSettings()).toEqual([]);
  const migrationAudit = store.settings
    .audit()
    .filter((entry) => entry.actor === "migration");
  expect(migrationAudit.length).toBeGreaterThan(0);

  const versions = [
    store.settings.read({ kind: "global" }).version,
    store.settings.read({ kind: "repository", repoId: repo.id }).version,
  ];
  migrateSettings(store, config, "2026-09-15T02:00:00.000Z");
  expect([
    store.settings.read({ kind: "global" }).version,
    store.settings.read({ kind: "repository", repoId: repo.id }).version,
  ]).toEqual(versions);
  expect(
    store.settings.audit().filter((entry) => entry.actor === "migration"),
  ).toEqual(migrationAudit);
  store.close();
});
