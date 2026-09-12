# Brief: `loom task inspect`, app-server logs, relaunch message prefix

Read `AGENTS.md` first. This brief is three small, independent changes in `apps/coordinator`,
found while driving the first real task through the dev instance. Open one PR for all three.

## 1. `loom task inspect <taskId>` (the main item)

Diagnosing a stuck task today means hand-written `sqlite3 … json_extract(...)` queries against
the instance database. Add a read-only CLI command that prints, in this order:

1. Task: id, title, stage, `stageEnteredAt`, `attention` (reasons and since), `blocked`, `failed`,
   `reviewRound`, branch, `prNumber`, worktree path.
2. Runs (all, newest last): id, role, provider, mode, status, `blockedOn`, `sessionEpoch`,
   `attempts`, `sessionId`, `retryAt`, `unknownSince`, `lastTurn` (id, outcome, error),
   `pendingRequests` count, `endedAt` / `endReason`.
3. Messages per run: kind, status, attempts, `deliveredAt`, first 80 chars of text.
4. Open questions and pending approvals, if any.
5. The last 10 outbox rows for the task: key, status, `started_at`, `executor_finished_at`, and a
   one-line result when the row has one.
6. Findings: count by status, and each open finding's title and location.

Plain text, one fact per line, aligned columns, no colour. Add `--json` that prints the same data
as one JSON object. Use the store's existing read methods (`loadTaskState`, outbox and inbox
readers); add narrow store methods only if a read you need does not exist, and cover them with a
test in `packages/store`. Test the command's text output against a fixture task in the
coordinator's CLI tests, the same way the existing `task` subcommands are tested. Document the
command in `apps/coordinator/README.md` next to the other `task` subcommands.

## 2. Capture the per-task Codex app-server's stderr

`packages/adapters/codex/src/server.ts` spawns one `codex app-server` per task and discards its
stderr. Pipe it (append) to `<taskDirectory>/app-server.log`, opened with mode 0600, rotating
nothing. Log one line with the path when the server starts. Add a test in `server.test.ts` that a
server whose executable writes to stderr leaves it in that file.

## 3. Relaunch prepends the git observation twice

`launch()` in `packages/core/src/lifecycle.ts` prepends
`Current git observation: …` to an undelivered initial message on every launch, so a run that is
relaunched before its first message was delivered (attempt 2 of a message with `attempts === 0`)
gets two such lines. Make it replace the earlier line instead of prepending a second one, and add
a lifecycle test: launch twice with the same pending message, assert exactly one
`Current git observation:` line.

## Rules for this work

- Do not change stage rules, the reconciler's decisions, or any adapter contract.
- Never run the dev or stable coordinator instances, never open `~/.loom/dev/loom.sqlite`.
  Tests use temporary directories and the fake agent.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green before opening the PR. Say in the PR how you
  tested each of the three items.
