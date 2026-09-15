# SQLite store

`@loom/store` persists the coordinator's owned state with better-sqlite3, WAL,
foreign keys and full synchronous commits. It never launches agents or makes
workflow decisions. Runtime dependencies include core/protocol, better-sqlite3 and zod;
the Claude adapter is a development dependency used only for its `HookLog` types.

```ts
const store = await openStore({ dataRoot, instance: "dev", config });
store.putRepo(repo);
store.createTask(initialTask); // backlog, version 0, no worktree
const state = store.loadTaskState(taskId);
const inputs = store.pendingInputs(taskId);
const result = reconcile(state, { ...freshObservations, inputs });
const committed = store.commit(taskId, result, state.task.version);
// If committed.ok is false, reload state and observations, then reconcile again.
```

`dataRoot/<instance>/loom.sqlite` and its `tasks/` and `backups/` siblings belong to
one instance. `instance` defaults to `LOOM_INSTANCE`; neither it nor `dataRoot` has
an implicit production default. `config` is injected on open, including the pure
hash/session-ID functions. It is never serialized. Use a supported Node LTS runtime
(verified here with Node 22.13.0); the native SQLite binding is built at install.

## Atomic commits and receipts

`commit(taskId, result, expectedVersion)` requires the version originally loaded.
`ReconcileResult` has no old-version field, and a fixed-point result keeps its
version, so subtracting one from `result.next.task.version` would be incorrect.

One immediate transaction compares task and optional capacity versions, saves
entities and context, consumes exactly `result.inputs`, appends audit transitions,
and saves keyed outbox intents and immutable artifact versions. Conflicts return
`task_version`, `capacity_version`, or `input_consumed`, with no writes or files.
Malformed state throws and rolls back. Accepted and rejected input dispositions
remain replayable through `inputDisposition`; all consumed IDs reload with state.
Enqueueing the same input ID and payload is a no-op; identity reuse with different
content fails.

Entity JSON is validated with zod on read and write. Indexed facts use generated
SQL columns, avoiding a second independently maintained copy of stage, version,
provider or run status. JSON updates preserve unknown additive object fields for
older-build rollback. Child identities, dependency foreign keys, provider/session
uniqueness, immutable finding anchors and versioned finding locations are retained.

Loads use one read transaction. They include live runs and the latest ended run
per role, pending/sent messages, unanswered questions, non-void approvals, all
findings, required task context, latest artifact metadata/content, all consumed
receipts, and all retained outbox rows. Outbox history is conservatively retained;
there is no premature pruning of retry or dependency receipts. Historical entity
rows remain stored when omitted from the active snapshot. Missing context or an
artifact absent from its durable version manifest fails loading.

## Executor boundary

```ts
const claim = store.outbox.claim(now);
if (claim && store.outbox.isClaimCurrent(claim.key, claim.claimVersion)) {
  // The executor performs/reconciles the external action, then supplies its input.
  store.outbox.finish(claim.key, claim.claimVersion, actionResultInput);
}
```

Claims honor `retryAt`, require every `dependsOn` row to have succeeded, and ignore
canceled rows. Claim generations are separate from core's retry attempt counter.
Claiming, requeueing and recording an executor receipt increment the task version
so an older reconcile cannot overwrite them. Recheck the claim before side effects;
action idempotence against the external owner remains the executor's responsibility.

`finish` atomically saves the executor completion receipt and its inbox input. It
leaves the core-visible entry running, with null `finishedAt`, until core consumes
that input: core deliberately ignores already-finished rows. Dependencies therefore
wait for the result's reconcile commit. Duplicate and stale claim completions are
no-ops. Canceled actions cannot be revived by a late result.

`startupRunning` reports uncertain running actions that have no executor receipt.
It never replays them. After checking the owner, the coordinator may explicitly
`requeue(key, claimVersion)` or record the recovered result. Already-recorded
results survive restart as pending inbox inputs and are not reported as uncertain.

## Artifacts and migrations

Artifact metadata and canonical JSON bytes commit atomically in SQLite. Files at
`tasks/<taskId>/<kind>/v<N>.json` are projections, written after commit with fsync
and atomic rename. A crash between SQL and file writing is repaired on startup;
`repairArtifactFiles()` can retry explicitly. A committed result reports file
failures in `materializationErrors`, so callers never mistake projection failure
for a rolled-back commit. Hash/path/version disagreements fail. Symlink parents and
escaping paths are refused. `artifact` and `materializeArtifact` require an exact
kind/version, including when a newer version exists.

Core exposes only the final version of each artifact kind in a reconcile result.
Several inputs in one pass can increment a kind more than once; committed versions
must increase, but may have gaps. The store cannot invent the omitted intermediate
contents. All versions actually received remain immutable. A live `write_task_files` action
referencing an unavailable intermediate version makes the whole commit fail.
`pendingInputs` defaults to one input per pass to avoid this core-contract gap;
callers may request a larger limit only when they can handle a rejected batch.
Supporting every intermediate version in arbitrary batches needs a future core
contract extension; the store neither reconstructs missing content nor redirects
old actions to newer content.

Numbered SQL migrations apply in individual immediate transactions, recording
`meta.schema_version` and a migration ledger. The SQLite backup API snapshots the
database, including committed WAL pages, before any pending migration is applied.
Concurrent openers recheck versions after the asynchronous backup. Failed migration
DDL and its version roll back together. Unknown additive migrations are compatible;
an unknown migration marked `-- breaking` prevents an older build from opening.
Do not edit merged migrations. Removal migrations must be marked breaking and ship
at least one release after the last reader is removed.

The schema uses validated entity JSON plus relational ownership/index columns and an artifact
version manifest. [migrations/](migrations/) is the schema history; optional fields preserve absent
versus explicit-null semantics. Loading never fabricates missing context for an active task.

Task JSON includes a positive per-repository `number` and nullable one-line `name`. Creation assigns
the next number inside the existing immediate transaction; the `tasks_repo_number` expression index
is the uniqueness backstop. Migration 0007 backfills numbers in `createdAt`, then ID, order per repo.

`hooks` implements Claude's `HookLog`, preserving append order and extra payload
fields. Startup and `hooks.prune(now)` remove receipts strictly older than seven
days. Capacity counts include starting/working/blocked non-ended runs; dependency
reads treat `done` as merged, per core's GitHub-derived stage contract. Stage and
attention queries read the stored derived fields without recomputing decisions.

## Verification

Colocated store tests use temporary database files, separate connections, real WAL, backups and artifact
files; no real agents or shared daemons are started. Fixtures cover owned core
state and synthetic hook receipts, not copied production data.

## Shared validation

Core owns entity types and closed value lists. Protocol owns entity zod shapes and exposes
`storedEntities`, preserving the store's existing scalar rules and unknown-key stripping.
[entity-schemas.ts](src/entity-schemas.ts) applies core contract checks to those schemas; action
and input schemas compose their shared pieces. No entity field list is maintained in the store.
