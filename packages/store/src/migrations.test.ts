import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings } from "@loom/core";
import { settingsValues } from "@loom/protocol";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { now, repo, required, richState, task } from "../test/fixtures.js";
import { outboxSchema } from "./action-schemas.js";
import {
  approvalSchema,
  messageSchema,
  runSchema,
  taskSchema,
} from "./entity-schemas.js";
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

describe("current rows (0011)", () => {
  async function seed() {
    const db = open();
    await migrate(db, join(root, "backups"), migrations.slice(0, 10));
    db.prepare("INSERT INTO repos(id, data) VALUES (?, ?)").run(
      repo.id,
      JSON.stringify(repo),
    );
    return db;
  }
  function insert(
    db: Database.Database,
    table: string,
    id: string,
    data: unknown,
  ) {
    db.prepare(
      `INSERT INTO ${table}(${table === "outbox" ? "key" : "id"}, ${table === "tasks" ? "repo_id" : "task_id"}, data) VALUES (?, ?, ?)`,
    ).run(id, table === "tasks" ? repo.id : "t1", JSON.stringify(data));
  }
  function read(db: Database.Database, table: string, id: string) {
    return JSON.parse(
      db
        .prepare(
          `SELECT data FROM ${table} WHERE ${table === "outbox" ? "key" : "id"} = ?`,
        )
        .pluck()
        .get(id) as string,
    );
  }
  it("fills every missing field, preserves current values, and retires only attempted ended-run messages", async () => {
    const db = await seed();
    expect(
      required(migrations.find((migration) => migration.version === 11))
        .breaking,
    ).toBe(false);
    const state = richState();
    const originalTask = {
      ...task(),
      version: 7,
      attention: {
        reasons: ["question", "blocked"],
        since: now,
        reasonSince: { question: now, blocked: null },
      },
    };
    insert(db, "tasks", "t1", originalTask);
    const originalRun = required(state.runs[0]);
    for (const [id, status, lastActivityAt, launchedAt, idleSince] of [
      ["activity", "idle", now, null, undefined],
      ["launch", "idle", null, now, null],
      ["clock", "idle", null, null, undefined],
      ["working", "working", now, now, undefined],
      ["ended", "ended", now, now, undefined],
      ["current", "idle", now, now, now],
    ] as const) {
      insert(db, "runs", id, {
        ...originalRun,
        id,
        status,
        sessionId: id,
        lastActivityAt,
        launchedAt,
        idleSince,
        access:
          id === "current"
            ? "approval-gated"
            : id === "launch"
              ? null
              : undefined,
        endedAt: id === "ended" ? now : null,
      });
    }
    const currentRun = read(db, "runs", "current");
    const originalMessage = required(state.messages[0]);
    for (const [id, status, attempts, sentAt, pendingSince] of [
      ["sent", "sent", 1, now, undefined],
      ["attempted", "pending", 1, null, null],
      ["unsent", "pending", 0, now, undefined],
      ["delivered", "delivered", 1, now, undefined],
      ["failed", "failed", 1, null, undefined],
      ["current", "pending", 0, null, now],
    ] as const) {
      insert(db, "messages", id, {
        ...originalMessage,
        id,
        runId: "ended",
        status,
        attempts,
        sentAt,
        pendingSince,
        when:
          id === "current" ? "after_turn" : id === "sent" ? undefined : null,
        deliveryAttention: id !== "current",
      });
    }
    insert(db, "messages", "live", {
      ...originalMessage,
      id: "live",
      runId: "activity",
      status: "sent",
      deliveryAttention: true,
    });
    const liveMessage = read(db, "messages", "live");
    const currentMessage = read(db, "messages", "current");
    const merge = {
      ...required(state.approvals[0]),
      kind: "merge",
      headSha: "a".repeat(40),
      findings: { hash: "a".repeat(64), findings: [], openBlocking: 0 },
      ci: {
        headSha: "a".repeat(40),
        observedAt: now,
        conclusion: "success",
        checks: [],
      },
    };
    for (const [id, approvedBy] of [
      ["old", undefined],
      ["null", null],
      ["current", "policy"],
    ] as const)
      insert(db, "approvals", id, { ...merge, id, approvedBy });
    insert(db, "approvals", "plan", required(state.approvals[0]));
    const currentApproval = read(db, "approvals", "current");
    for (const [id, access] of [
      ["old", undefined],
      ["null", null],
      ["current", "approval-gated"],
    ] as const)
      insert(db, "outbox", id, {
        key: id,
        kind: "start_run",
        status: "pending",
        attempts: 0,
        createdAt: now,
        finishedAt: null,
        action: {
          key: id,
          taskId: "t1",
          kind: "start_run",
          runId: "activity",
          role: "planner",
          provider: "codex",
          mode: "interactive",
          worktreePath: "/tmp/test",
          model: "test",
          attempt: 1,
          sessionEpoch: 0,
          sessionId: null,
          resume: false,
          access,
        },
      });
    const currentOutbox = read(db, "outbox", "current");
    const before = new Date().toISOString();
    await migrate(db, join(root, "backups"));
    const after = new Date().toISOString();
    const migrationTime = read(db, "runs", "clock").idleSince;
    expect(migrationTime >= before && migrationTime <= after).toBe(true);
    for (const id of ["activity", "launch"])
      expect(read(db, "runs", id)).toMatchObject({
        access: "full",
        idleSince: now,
      });
    for (const id of ["working", "ended"])
      expect(read(db, "runs", id)).toMatchObject({
        access: "full",
        idleSince: null,
      });
    expect(read(db, "runs", "current")).toEqual(currentRun);
    expect(read(db, "tasks", "t1")).toEqual({
      ...originalTask,
      attention: {
        ...originalTask.attention,
        reasonSince: { question: now, blocked: now },
      },
    });
    for (const id of ["sent", "attempted"])
      expect(read(db, "messages", id)).toMatchObject({
        status: "failed",
        deliveryAttention: false,
        when: "now",
      });
    expect(read(db, "messages", "sent").pendingSince).toBe(now);
    expect(read(db, "messages", "attempted").pendingSince).toBe(migrationTime);
    expect(read(db, "messages", "unsent")).toMatchObject({
      status: "pending",
      attempts: 0,
      pendingSince: migrationTime,
    });
    expect(read(db, "messages", "delivered")).toMatchObject({
      status: "delivered",
      pendingSince: now,
    });
    expect(read(db, "messages", "failed").pendingSince).toBe(migrationTime);
    expect(read(db, "messages", "current")).toEqual(currentMessage);
    expect(read(db, "messages", "live")).toEqual(liveMessage);
    for (const id of ["old", "null"]) {
      expect(read(db, "approvals", id).approvedBy).toBe("human");
      expect(read(db, "outbox", id).action.access).toBe("full");
    }
    expect(read(db, "approvals", "current")).toEqual(currentApproval);
    expect(read(db, "outbox", "current")).toEqual(currentOutbox);
    expect(read(db, "approvals", "plan")).toEqual(required(state.approvals[0]));
    for (const [table, schema] of Object.entries({
      tasks: taskSchema,
      runs: runSchema,
      messages: messageSchema,
      approvals: approvalSchema,
      outbox: outboxSchema,
    }))
      for (const row of db.prepare(`SELECT data FROM ${table}`).pluck().all())
        schema.parse(JSON.parse(row as string));
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const snapshot = db.serialize();
    expect(await migrate(db, join(root, "backups"))).toEqual([]);
    expect(db.serialize().equals(snapshot)).toBe(true);
    db.exec(
      required(migrations.find((migration) => migration.version === 11)).sql,
    );
    expect(read(db, "messages", "unsent").pendingSince).toBe(migrationTime);
  });
  it.each(["baseBranch", "defaultProviders", "serialTests"])(
    "refuses a repository with %s and rolls back all changes",
    async (key) => {
      const db = await seed();
      db.prepare("UPDATE repos SET data = ?").run(
        JSON.stringify({ ...repo, [key]: null }),
      );
      const snapshot = db.serialize();
      await expect(migrate(db, join(root, "backups"))).rejects.toThrow(
        "run_a_203_build_to_import_repository_settings",
      );
      expect(schemaVersion(db)).toBe(10);
      expect(db.serialize().equals(snapshot)).toBe(true);
    },
  );
  it.each([undefined, null])(
    "fills a missing reason map (%s) including empty attention",
    async (reasonSince) => {
      const db = await seed();
      for (const [id, reasons] of [
        ["t1", ["question"]],
        ["t2", []],
      ] as const)
        insert(db, "tasks", id, {
          ...task(),
          id,
          number: id === "t1" ? 1 : 2,
          attention: {
            reasons,
            since: reasons.length ? now : null,
            reasonSince,
          },
        });
      await migrate(db, join(root, "backups"));
      expect(read(db, "tasks", "t1").attention.reasonSince).toEqual({
        question: now,
      });
      expect(read(db, "tasks", "t2").attention.reasonSince).toEqual({});
    },
  );
});

it("0013 preserves Main documents and removes obsolete headless agent entries", async () => {
  const db = open();
  await migrate(db, join(root, "backups"), migrations.slice(0, 12));
  const saved = {
    id: "main",
    origin: "main",
    document: { title: "Saved", body: "Keep this", sources: [] },
  };
  const insert = db.prepare(
    "INSERT INTO research(id,value,started_at,archived_at) VALUES (?, ?, ?, NULL)",
  );
  insert.run("main", JSON.stringify(saved), now);
  insert.run(
    "agent",
    JSON.stringify({ id: "agent", origin: "agent", status: "failed" }),
    now,
  );
  await migrate(db, join(root, "backups"));
  const rows = db.prepare("SELECT value FROM research").pluck().all();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0]))).toEqual({
    ...saved,
    directory: null,
    pane: null,
    observedStatus: "unknown",
  });
  await migrate(db, join(root, "backups"));
  expect(db.prepare("SELECT value FROM research").pluck().all()).toEqual(rows);
});

it("0016 removes retired test settings in every scope and preserves other values", async () => {
  const db = open();
  await migrate(db, join(root, "backups"), migrations.slice(0, 15));
  const insert = db.prepare(
    "INSERT INTO settings(scope, repo_id, version, data, updated_at) VALUES (?, ?, 7, ?, ?)",
  );
  for (const [scope, repoId, repository] of [
    ["global", "", { baseBranch: "develop", serialTests: true }],
    ["repository", "widgets", { baseBranch: "release", serialTests: false }],
    ["repository", "other", { baseBranch: "main", serialTests: null }],
    ["repository", "unchanged", { baseBranch: "stable" }],
  ] as const)
    insert.run(scope, repoId, JSON.stringify({ repository }), now);
  await migrate(db, join(root, "backups"));
  const rows = db.prepare("SELECT * FROM settings ORDER BY repo_id").all() as {
    scope: string;
    repo_id: string;
    version: number;
    data: string;
    updated_at: string;
  }[];
  expect(rows.map((row) => JSON.parse(row.data))).toEqual(
    ["develop", "main", "stable", "release"].map((baseBranch) => ({
      repository: { baseBranch },
    })),
  );
  for (const row of rows) {
    expect(row.version).toBe(7);
    expect(row.updated_at).toBe(now);
    const { effective } = resolveSettings(JSON.parse(row.data), null, null);
    expect(settingsValues.safeParse(effective).success).toBe(true);
  }
  expect(await migrate(db, join(root, "backups"))).toEqual([]);
  expect(db.prepare("SELECT * FROM settings ORDER BY repo_id").all()).toEqual(
    rows,
  );
});
