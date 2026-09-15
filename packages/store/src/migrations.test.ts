import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repo, required, task } from "../test/fixtures.js";
import { migrate, readMigrations, schemaVersion } from "./migrations.js";

let root: string;
const connections: Database.Database[] = [];
function open(name = "loom.sqlite") {
  const db = new Database(join(root, name));
  db.pragma("journal_mode = WAL");
  connections.push(db);
  return db;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-migrations-"));
});
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});
const migrations = readMigrations();
describe("numbered migrations", () => {
  for (const migration of migrations) {
    it(`applies ${migration.name} from empty and from the previous version`, async () => {
      const empty = open("empty.sqlite");
      await migrate(
        empty,
        join(root, "empty-backups"),
        migrations.slice(0, migration.version),
      );
      expect(schemaVersion(empty)).toBe(migration.version);
      const previous = open("previous.sqlite");
      await migrate(
        previous,
        join(root, "previous-backups"),
        migrations.slice(0, migration.version - 1),
      );
      await migrate(
        previous,
        join(root, "previous-backups"),
        migrations.slice(0, migration.version),
      );
      expect(schemaVersion(previous)).toBe(migration.version);
      expect(
        previous
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
      ).toEqual(
        empty
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
      );
    });
  }
  it("backfills task numbers per repo by creation time without changing versions", async () => {
    const db = open();
    await migrate(db, join(root, "backups"), migrations.slice(0, 6));
    const otherRepo = {
      ...repo,
      id: "other",
      github: "example/other",
      root: `${repo.root}-other`,
    };
    for (const value of [repo, otherRepo])
      db.prepare("INSERT INTO repos(id, data) VALUES (?, ?)").run(
        value.id,
        JSON.stringify(value),
      );
    const insert = db.prepare(
      "INSERT INTO tasks(id, repo_id, data) VALUES (?, ?, ?)",
    );
    const legacy = (
      id: string,
      repoId: string,
      createdAt: string,
      version: number,
    ) => {
      const { number: _number, name: _name, ...data } = task(id as never);
      insert.run(
        id,
        repoId,
        JSON.stringify({ ...data, repoId, createdAt, version }),
      );
    };
    legacy("z", repo.id, "2026-01-02T00:00:00.000Z", 7);
    legacy("a", repo.id, "2026-01-01T00:00:00.000Z", 4);
    legacy("other", otherRepo.id, "2026-01-03T00:00:00.000Z", 9);
    await migrate(db, join(root, "backups"));
    const rows = db
      .prepare(
        "SELECT id, json_extract(data, '$.number') number, json_extract(data, '$.name') name, json_extract(data, '$.version') version FROM tasks ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "a", number: 1, name: null, version: 4 },
      { id: "other", number: 1, name: null, version: 9 },
      { id: "z", number: 2, name: null, version: 7 },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_repo_number'",
        )
        .pluck()
        .get(),
    ).toBe("tasks_repo_number");
  });
  it("drops the retired Operator tables", async () => {
    const db = open();
    await migrate(db, join(root, "backups"), migrations.slice(0, 9));
    const operatorTables = [
      "operator_events",
      "operator_notes",
      "operator_ledger",
      "operator_filings",
    ];
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${operatorTables.map(() => "?").join(", ")}) ORDER BY name`,
        )
        .pluck()
        .all(...operatorTables),
    ).toEqual([...operatorTables].sort());
    await migrate(db, join(root, "backups"));
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${operatorTables.map(() => "?").join(", ")})`,
        )
        .pluck()
        .all(...operatorTables),
    ).toEqual([]);
  });
  it("backs up committed WAL pages before applying changes and is idempotent", async () => {
    const db = open();
    await migrate(db, join(root, "backups"), migrations.slice(0, 1));
    db.prepare("INSERT INTO repos(id, data) VALUES (?, ?)").run(
      repo.id,
      JSON.stringify(repo),
    );
    db.prepare("INSERT INTO tasks(id, repo_id, data) VALUES (?, ?, ?)").run(
      task().id,
      repo.id,
      JSON.stringify(task()),
    );
    const backups = await migrate(db, join(root, "backups"));
    const backup = new Database(required(backups[0]));
    connections.push(backup);
    expect(schemaVersion(backup)).toBe(1);
    expect(backup.prepare("SELECT data FROM tasks").pluck().get()).toBe(
      JSON.stringify(task()),
    );
    expect(
      db
        .prepare(
          "SELECT json_extract(data, '$.budgetObservedAt') FROM task_context",
        )
        .pluck()
        .get(),
    ).toBe(task().createdAt);
    const count = readdirSync(join(root, "backups")).length;
    expect(await migrate(db, join(root, "backups"))).toEqual([]);
    expect(readdirSync(join(root, "backups"))).toHaveLength(count);
  });
  it("rolls back a failed migration and its version while retaining completed migrations", async () => {
    const db = open();
    const invalid = {
      version: migrations.length + 1,
      name: "0003_invalid.sql",
      breaking: false,
      sql: "CREATE TABLE must_rollback (id TEXT); INSERT INTO missing VALUES (1);",
    };
    await expect(
      migrate(db, join(root, "backups"), [...migrations, invalid]),
    ).rejects.toThrow();
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'")
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get(),
    ).toBe(migrations.length);
  });
  it("opens unknown additive versions but refuses an unknown breaking migration", async () => {
    const db = open();
    const future = {
      version: migrations.length + 1,
      name: "0003_future.sql",
      breaking: false,
      sql: "ALTER TABLE repos ADD COLUMN future TEXT;",
    };
    await migrate(db, join(root, "backups"), [...migrations, future]);
    await expect(migrate(db, join(root, "backups"))).resolves.toEqual([]);
    const breaking = {
      version: migrations.length + 2,
      name: "0004_remove_future.sql",
      breaking: true,
      sql: "ALTER TABLE repos DROP COLUMN future;",
    };
    await migrate(db, join(root, "backups"), [...migrations, future, breaking]);
    await expect(migrate(db, join(root, "backups"))).rejects.toThrow(
      "Unknown breaking migration",
    );
    await expect(
      migrate(db, join(root, "backups"), [...migrations, future, breaking]),
    ).resolves.toEqual([]);
  });
});
