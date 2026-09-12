# Codex adapter

`@loom/adapter-codex` implements the core Codex contract against **codex-cli 0.154.0**.
It owns one child app-server per task, outside Herdr, with a dedicated `codex-home`
and Unix socket beneath a caller-supplied task directory. It never reads a terminal,
changes stages, sends an initial prompt, or answers a provider request automatically.

## Coordinator integration

Create one adapter per task with `createCodexAdapter({ taskDirectory, initialGeneration })`.
The directory must be absolute, private to that task, and short enough for a Unix
socket (the complete socket path is limited to 100 bytes). The child receives a
scrubbed environment without inherited `HERDR_*`, `CLAUDE_CODE_*`, or `CODEX_*`
context; only its own `CODEX_HOME` is set. Authentication, when needed, must be
provisioned separately for that home. The adapter does not copy credentials or
change global config.

1. `startServer()` starts the child and initializes the connection. Repeated calls
   are idempotent. A preexisting socket is refused; an existing private server can
   instead be reached explicitly with `reconnect()`. Only the child this instance
   spawned can be stopped by `stopServer()`.
2. Call `startThread()` with an explicit model and persist its ID and connection
   generation **before** calling `startTurn()`. Thread allocation never sends a turn.
3. `subscribe()` emits hints for the coordinator to enqueue reconciliation. Reads
   throw on unavailable or malformed responses; wrap these as failed core `Reading`s,
   never as idle/failed provider snapshots.
4. After connection loss, `generation()` is null. Call `reconnect()`, persist its
   new generation, then `resumeThread()` for each recorded thread. `readThread()`
   requires that subscription so pending requests have been replayed. Supply the
   last persisted generation as `initialGeneration` after a coordinator restart.
5. Read rate limits with `readRateLimits()` during reconciliation. Thread snapshots
   leave `rateLimits` null rather than copying a previous account snapshot or sparse
   update. A null backend usage allowance is an unavailable read, not permission
   to run. Reset time is the latest reset among exhausted windows; the explicit
   backend boolean decides whether ordinary usage is allowed.
6. `checkResumable()` uses a separate initialized connection. A metadata read
   succeeds for a loaded thread. On the exact `thread not loaded: <id>` error, it
   attempts native resume without turns. This can load an unloaded thread, so
   **only pass recorded Loom-owned thread IDs**, never external sessions. Only the
   exact missing-rollout error becomes false; connectivity, permissions, malformed
   output and other failures remain null. The probe never starts a turn.
7. Persist `activityAt()` in the coordinator. It uses provider snapshot timestamps,
   timestamped activity notifications, and request start times (receipt time when
   the protocol supplies no timestamp). Unchanged polls and replayed timestamped
   events do not advance it. The in-memory timestamp survives reconnects, not a new
   adapter instance.

Pending requests retain the original numeric/string wire ID, the thread identity,
and the connection generation. Answers are explicit and stay visible until
`serverRequest/resolved`. Permission grants are limited to the requested permissions
for one turn. No session-wide grants or policy amendments are added. The generated
bindings type outbound parameters and answers; zod validates the inbound projections
that Loom consumes. Unknown server-request methods fail the connection without a
response. Unknown notifications remain hints.

RPC timeouts and disconnects never automatically replay operations. Interruption
is not evidence that a subprocess stopped or that side effects did not run. The
coordinator must reconcile the worktree before retrying.

## Protocol findings and limits

The real private-server smoke test on 0.154.0 confirmed:

- Unix WebSocket `/rpc`, `Host: localhost`, compression disabled, then
  `initialize` with `experimentalApi` and `initialized`.
- Notifications include an envelope-level `emittedAtMs`. Rejecting this field
  disconnects immediately on `remoteControl/status/changed`.
- A fresh connection can read a newly allocated loaded thread before its first
  turn. This confirms current existence, not persistence through a server crash.
- A nonexistent ID returns `thread not loaded: <id>` from `thread/read`, even
  with `includeTurns: true`. Native resume distinguishes missing history with
  `no rollout found for thread id <id>`.

New threads explicitly use `historyMode: legacy` for complete snapshot hydration.
Partial/paginated histories are rejected rather than silently losing delivery
hashes; adding pagination is separate work. As spike 01 observed, a newly allocated
ID may not have durable rollout history until its first turn. Snapshot reads preserve
`notLoaded` separately from interrupted turn history. Model inference, concurrent
real-client approval races, and live quota exhaustion were not exercised by this
package's real smoke test; those paths are covered by fake traffic here.

## Bindings and tests

`src/generated` contains only the transitive closure of types used by this package,
produced with `codex app-server generate-ts --experimental`. The generator refuses
any version other than 0.154.0 and adds `.js` extensions for Node ESM. Regenerate with
`pnpm --filter @loom/adapter-codex generate`. Generated files have a local Biome
exemption; handwritten source remains checked. Nothing imports `spikes/`.

Run from the repository root:

```sh
pnpm test
pnpm lint
pnpm typecheck
LOOM_REAL_PROVIDERS=1 pnpm exec vitest run packages/adapters/codex/src/real.test.ts --reporter=verbose
```

Normal tests use private fake Unix WebSocket servers and a tiny fake CLI child,
never a real coding agent. The opt-in test uses its own temporary home/socket,
names `gpt-5.6-luna` explicitly, and exercises lifecycle and thread allocation
without sending a model prompt or requiring credentials. Both suites clean up
only their own processes and temporary directories. A sandbox that denies Unix
socket binding must allow these test commands to run outside it.
