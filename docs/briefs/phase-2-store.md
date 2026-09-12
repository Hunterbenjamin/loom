# Phase 2: `packages/store`

**Agent:** codex · **Branch:** `feat/store` · **PR title:** "Phase 2: SQLite store". Read
[`phase-2-common.md`](phase-2-common.md) first; the package shape and rules apply, with the path
`packages/store` instead of `adapters/`.

## Build

The coordinator's persistence: SQLite through `better-sqlite3` in WAL mode, one database per
instance data directory (`LOOM_INSTANCE`), artifact content as files beside it. The design is
[`docs/design/core.md`](../design/core.md) §8, and the shape of what must be loaded and committed is
`TaskState` and `ReconcileResult` in `packages/core/src/reconcile.ts`. Where the SQL sketch and the
types disagree, the types win; say so in the PR.

- **Migrations:** numbered files in `migrations/NNNN_<name>.sql`, each in its own transaction, bumping
  `meta.schema_version`. Additive only: new tables, indexes, and nullable or defaulted columns. A
  `breaking` marker for the removal migrations that come at least one release later. Back the database
  up with the SQLite backup API before applying any. A build refuses to start only on an unknown
  `breaking` migration.
- **`loadTaskState(taskId)`:** one read transaction returning a complete `TaskState`, including the
  Phase 1b fields (`consumedInputIds`, `artifactContents`, `plan`, `review`, `desiredRun`,
  `activeElapsedMs`, `budgetObservedAt`, `progress`) and the outbox entries the design says a pass
  needs.
- **`commit(taskId, result)`:** one write transaction applying a `ReconcileResult`: the stage
  compare-and-set on `tasks.version`, the capacity compare-and-set when `capacityVersion` is present,
  consuming exactly the inputs in `result.inputs`, inserting outbox rows by key (a duplicate key is a
  no-op), appending transitions, and writing artifact versions and their files. A failed CAS writes
  nothing and returns a typed conflict.
- **Inbox and outbox:** enqueue inputs; claim and finish outbox rows for the executor, with the
  `retryAt`, `dependsOn` and `canceled` semantics the design gives them; on startup, report the rows
  that were `running` when the process died.
- **Hook receipts:** implement the Claude adapter's `HookLog` interface (`packages/adapters/claude`)
  on the `claude_hooks` table, pruned after 7 days.
- **Cross-task reads** the coordinator needs: capacity counts, dependency stages, tasks by stage,
  tasks needing attention.

## Tests

Run against a temporary database file, never in-memory only, so WAL and the backup path are real.
Cover: every migration applies from empty and from the previous version; `loadTaskState` round-trips a
fixture state through `commit`; a stale-version commit writes nothing; a capacity CAS conflict; inputs
consumed exactly once across two concurrent commits; outbox key idempotency; restart recovery of
`running` rows; hook receipt storage and pruning.

## Out of scope

The executor, adapters, and any reconcile logic. Nothing here decides; it only stores.
