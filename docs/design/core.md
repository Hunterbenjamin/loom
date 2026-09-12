# Core design

Current contract, updated with the Phase 1b implementation and PR #12 review corrections.
The types and pure implementation live in [`packages/core/src`](../../packages/core/src).
Phase 2 adapters and the future store/executor must implement this contract. PR #12 retains the
original deviations list as the history of what changed and why.
Built on [`docs/architecture.md`](../architecture.md) and the findings of spikes 01–05.

Ownership marks in the entity tables: **A** authoritative in Loom · **R** a reference to a fact another
tool owns · **C** a cache of another owner's fact, stored with its read time and never used to decide
without a fresh read · **D** derived by every reconcile, stored only so queries and snapshots are cheap.

## 1. Entities

Types: [`entities.ts`](../../packages/core/src/entities.ts), [`ids.ts`](../../packages/core/src/ids.ts).

### Task

| Field | Own | Notes |
|---|---|---|
| `id`, `repoId`, `title`, `description` | A | |
| `stage` | A | §2. Changes only in a reconcile commit. |
| `stageEnteredAt` | A | |
| `version` | A | Compare-and-set counter; +1 when the returned owned state changes, once per committed reconcile pass. |
| `blocked` | A | `{reason, since, detail, until, questionId}` or null. §3. |
| `failed` | A | `{reason, since, detail, runId}` or null. §3. |
| `requirePlanApproval` | A | Defaults from the repo; forced on for tasks labeled `core`. |
| `reviewRound`, `reviewRoundCap` | A | Rounds started so far; cap defaults to 3 and only a human raises it. |
| `providers` | A | Planner, implementer, reviewer. Rule default plus human override. |
| `blockedBy` | A | Task IDs that must be merged first. |
| `budgetMinutes` | A | Exceeding it adds attention; nothing else. |
| `worktreePath` | R git | The join key (realpath). Null until created. |
| `branch` | R git/GitHub | Loom picks the name (`loom/<taskId>-<slug>`); git and GitHub own the branch. |
| `prNumber` | R GitHub | |
| `attention` | D | §3. |

### Run

One run of one agent in one role, one row per (task, role, round). A retry relaunches that same row
(`attempts + 1`) and keeps its session; a fix round reuses the implementer's run and session. Only a
human relaunches an interactive run (§3).

| Field | Own | Notes |
|---|---|---|
| `id` | A | Deterministic: `<taskId>/<role>/<round>`. Stable across attempts. |
| `taskId`, `role`, `provider`, `mode`, `model` | A | Planner and reviewer are `headless`; implementer is `interactive`. |
| `origin` | A | `loom`, or `external` for a session started by hand in the worktree (observe-only). |
| `worktreePath`, `round` | A | |
| `attempts` | A | Launches of this run so far. A retry bumps it and keeps the row. |
| `sessionId` | R provider | Claude: UUIDv5 of `<runId>#<sessionEpoch>`, set when the row is inserted, before launch, and reused by every attempt of that epoch. Codex: thread ID from `thread/start`, recorded before the first `turn/start`. |
| `sessionEpoch` | A | Starts at 0. +1 only when the provider can no longer resume the session, which derives a fresh Claude session ID (for Codex, a new `thread/start`). |
| `codexGeneration` | R Codex | App-server connection generation; scopes request IDs. |
| `pane` | R pane host | `{hostGeneration, sessionName, windowId, paneId}` for interactive runs. `hostGeneration` scopes the pane ID: tmux restarts them at `%0` after a server death. |
| `status`, `blockedOn` | D | From provider observations; §4. |
| `lastTurn` | C provider | `{id, outcome, error}`. Kept apart from `status`. |
| `pendingRequests` | C provider | Approvals and questions the provider is waiting on. |
| `lastActivityAt` | A | Latest provider activity evidence from `RunObservation.activityAt` (or Claude hook activity), not the timestamp of a no-change poll. Drives stall detection. |
| `retryAt` | A | Backoff: `min(10s·2^(n−1), cap)`. |
| `launchedAt`, `endedAt`, `endReason` | A | `submitted`, `superseded`, `canceled`, `crashed`, `vanished`, `failed`, `task_done`. |

The following lifecycle fields are written by core and retained by the store whenever present.
They follow the original fields in `Run`; their optional representation has these explicit initial defaults:

| Field | Own | Meaning / initial value |
|---|---|---|
| `seenAt` | A | First authoritative evidence of this session; absent/null means never seen. Required to distinguish a not-yet-present Claude start from a vanished session after restart. |
| `unknownSince` | A | Start of the current unknown-status interval; absent/null means no such interval. Repeated unavailable reads do not reset it. |
| `observedAttempt` | A | Attempt whose failure was already scheduled; absent means no failure handled for this attempt. |
| `retryBaseAttempt` | A | Monotonic attempt offset at the last human retry reset; absent means 0. Attempts themselves never reset, so action keys cannot be reused. |

A launch clears `launchedAt` until its matching `start_run` result commits. Old snapshots do not
unlock messages while that launch is pending. The provider adapter supplies explicit resumability
(§5.2); only a fresh `resumable: false` can cause a new session epoch. Provider recovery cancels a
scheduled run retry. Automatic headless retries require fresh provider and git evidence and capacity;
interactive failure recovery remains a human action.

### Worktree

| Field | Own | Notes |
|---|---|---|
| `path` | A | Primary key. Canonical realpath (`/private/var/…`, never `/var/…`). |
| `taskId`, `repoId`, `branch`, `baseBranch`, `baseSha` | A | `baseSha` is the base when the worktree was created. |
| `portSlot` | A | Null until ports land (Phase 5). |
| `paneWorkspaceId` | R pane host | The task's pane-host session; one window per run lives in it. |
| `createdAt`, `removedAt` | A | |
| `git` | C git | `{headSha, dirty, aheadOfBase, at}`. |

### Artifact

Metadata and versioned content are committed durably together (§8), then materialized as files in
the data directory and mirrored to `<worktree>/.task/` by the executor.

| Field | Own | Notes |
|---|---|---|
| `id`, `taskId`, `kind` | A | `brief`, `plan`, `decisions`, `findings`, `test_results`, `handoff`. |
| `version` | A | Monotonic per (task, kind). `decisions` is append-only. |
| `path`, `sha256` | A | Relative to the data directory. |
| `createdBy`, `createdAt` | A | `human`, `coordinator` or a run. |

`findings.json` is a projection of the findings table, written for agents; the table is the source.
Plan content is the `Plan` type (goal, non-goals, steps, areas, acceptance criteria, test plan, risks,
open questions, suggested implementer). Core serializes versioned contents as JSON and hashes those
bytes with the injected SHA-256 function. Decisions and test evidence accumulate. A test record
includes `runId`, `ranAt` and `headSha`; nonempty progress test reports require a fresh git HEAD.
Every findings mutation updates its artifact projection. Object key order alone is not a mutation.

### Finding

| Field | Own | Notes |
|---|---|---|
| `id`, `taskId`, `round` | A | |
| `source` | A | `reviewer`, `human`, `github`, `ci`, `system`. |
| `externalId` | R GitHub | Comment ID or check-run ID; dedupes imports. |
| `createdByRunId` | A | |
| `severity` | A | `blocker`, `major`, `minor`, `nit`. Chosen by the agent or human. |
| `blocking` | A | Decided by code at creation: `blocker`/`major` block; §2 notes the GitHub rule. |
| `title`, `body` | A | |
| `status`, `reopenCount` | A | `open`, `addressed`, `disputed`, `resolved`, `waived`. |
| `anchor` | A | Immutable, from spike 04: base/head SHA, old/new path, old/new blob OID, side, line range, optional columns, selected text and its hash, context-before/after hashes, normalization. Null for task-level findings. |
| `location` | A | Current mapping: `{headSha, path, blobOid, side, startLine, endLine, status, version, mappedAt}`; status is `exact`, `moved`, `ambiguous` or `outdated`. |
| `resolution` | A | `{by, note, commitSha, at}`. |

Finding status and mapping status are separate. `outdated` never resolves a finding, and mapping never
picks the nearest duplicate. Mapping runs through Git hunks and verified renames (the `map_findings`
action); the same head always gives the same mapping.

### Approval

| Field | Own | Notes |
|---|---|---|
| `id`, `taskId`, `kind` | A | `plan` or `merge`. |
| `planVersion` | A | Plan approvals: the plan version approved. |
| `headSha` | A | Merge approvals: the exact commit. |
| `findings` | A | Snapshot: `(id, status, severity)` of every finding, its hash, and the open blocking count. |
| `ci` | C GitHub | CI state at approval time: head SHA, conclusion, checks. |
| `voidedAt`, `voidReason` | A | `new_commit`, `ci_failed`, `findings_changed`, `plan_changed`, `stage_left`. |

### Transition (audit log)

Append-only; one row per committed stage change or flag change.

| Field | Own | Notes |
|---|---|---|
| `id`, `taskId`, `at` | A | |
| `from`, `to` | A | Equal for a flag-only change. |
| `flags` | A | `{blocked?: {from, to}, failed?: {from, to}}`. |
| `trigger` | A | `human` (command, inputId), `mcp` (tool, runId, inputId) or `reconcile` (the fact). |
| `reason`, `taskVersion` | A | Version after the change. |

### Supporting records

| Entity | Fields | Notes |
|---|---|---|
| Message | `id, runId, purpose, text, textHash, status, attempts, transportRef, sentAt, delivered`, plus delivery metadata below | Status `pending → sent → delivered` (or `failed`). §5.5. |
| Question | `id, taskId, runId, question, options, blocking, askedAt, answer, answeredAt` | From `ask_human`. |
| Repo | `id, root, github, baseBranch, defaultProviders, serialTests` | |

Delivery metadata follows the original `Message` fields. Core writes it and the store must retain it:
`via` identifies the transport path (absent before send), `expectedTurnId` identifies a steered turn,
`baselineTurnId` identifies the last observed turn before sending (absent/null means none), and
`deliveryAttention` defaults to false. These fields are never reconstructed from a terminal.

`CiCheck.id` is required: the GitHub adapter supplies the stringified stable check-run ID. Core uses
it as the CI finding's external identity; name/head fallbacks are no longer permitted. The ID remains
part of the CI snapshot captured in a merge approval.

### IDs

Reconcile is pure, so it can't draw random IDs. IDs it creates are derived from stable keys: run IDs
from `(task, role, round)`, Claude session IDs as UUIDv5 of `<runId>#<sessionEpoch>`, message IDs from
`(run, purpose, sequence)`, action keys from the intent (§5.5). IDs that arrive with an input (finding
IDs, question IDs) are assigned by the I/O layer when the input is persisted.

The coordinator injects pure `deriveClaudeSessionId(runId, epoch)` (UUIDv5 in a stable Loom namespace)
and `sha256(text)` functions through `ReconcileConfig`. SHA-256 covers normalized message text,
serialized artifact content, and sorted finding snapshot triples. The namespace and hash implementation
must be stable across restarts. These functions are runtime configuration, never serialized store data.
The same config also supplies `worktreeRoot`, `baseBranch`, and `models` by provider in addition to
retry/timing thresholds. `githubPollMs` is the coordinator's polling policy; core does not perform polling.

## 2. Stage rules

| Stage | Who works | Notes |
|---|---|---|
| `backlog` | nobody | Parked. |
| `todo` | nobody | Queued for capacity and dependencies. |
| `planning` | planner (headless) | |
| `plan_approval` | nobody | Only when `requirePlanApproval`. |
| `in_progress` | implementer (interactive, in a pane) | |
| `in_review` | reviewer (headless, editing disabled) | The implementer's session stays alive for fix rounds. |
| `awaiting_approval` | nobody | Human reviews the diff. |
| `merging` | nobody | Merge requested; waiting to see it on GitHub. |
| `done`, `canceled` | nobody | Terminal (`canceled` can be reopened). |

Triggers: **H** human command, **M** MCP tool call from the task's *current* run for that role, **R** a fact
found by reconcile. "Start X" means insert the run row (with its session ID for Claude), then `start_run`,
then the first `send_message` once the session ID is recorded. "Resume X" reuses the existing run row and
its session, with `start_run` carrying `resume: true` when it is resumable. Missing worktrees are
created before constructing run rows. `TaskState.desiredRun` durably holds a role/round/resume intent
when setup, flags or capacity defer its start. Claude IDs exist before launch; both providers require
a committed launch/session result and an authoritative usable reading before the first prompt.

| # | From | To | Trigger | Guard | Actions |
|---|---|---|---|---|---|
| 1 | backlog | todo | H `move todo` | — | — |
| 2 | todo | backlog | H `move backlog` | — | — |
| 3 | todo | planning | R | All `blockedBy` merged; no accepted plan; capacity CAS for the planner's provider; provider not cooling down; no flags | `create_worktree` (if none), `open_workspace`, `write_task_files`, start planner |
| 4 | todo | in_progress | R | As #3, but an accepted plan exists (task was parked after planning) | `write_task_files`, resume the implementer's session if it has one, else start implementer |
| 5 | planning | plan_approval | M `submit_plan` | Plan passes schema; `requirePlanApproval` | Store plan vN; `stop_run` planner; `notify` attention; overlap warning (Phase 5) |
| 6 | planning | in_progress | M `submit_plan` | Plan passes schema; not `requirePlanApproval`; capacity CAS | Store plan vN; `stop_run` planner; `write_task_files`; start implementer |
| 7 | plan_approval | in_progress | H `approve_plan(v)` | `v` is the latest plan version; capacity CAS | Insert plan Approval; `write_task_files`; start implementer |
| 8 | plan_approval | planning | H `reject_plan(feedback)` | — | Resume the planner's session; `send_message` feedback |
| 9 | in_progress | in_review | M `submit_for_review` | `headSha` = worktree HEAD; tree clean; ahead of base | `reviewRound += 1`; store handoff; `push_branch(headSha)`; `open_pr` (if none); start reviewer for the round |
| 10 | in_review | awaiting_approval | M `submit_review` | `reviewedSha` = round head = PR head; a verdict for every `addressed`/`disputed` finding; after applying it, 0 open blocking; PR positively `mergeable`; CI for that head not failing | Store findings and verdicts; `stop_run` reviewer; `notify` attention |
| 11 | in_review | in_progress | M `submit_review` | Same SHA and verdict guards; open blocking > 0; `reviewRound < reviewRoundCap`; converging | Store findings; `stop_run` reviewer; `send_message` fix round to the implementer (resume it if it ended) |
| 12 | in_review | in_review, flag | M `submit_review` | Open blocking > 0 and `reviewRound ≥ cap` → `blocked: review_round_cap`. A finding reopened, or open blocking ≥ last round's → `blocked: review_not_converging` | Store findings; `stop_run` reviewer; `notify` attention |
| 13 | in_review (blocked by #12) | in_progress | H `grant_review_round` | — | For `review_round_cap`, `reviewRoundCap += 1`; clear flag; `send_message` fix round to the implementer (resuming its run if it ended) |
| 14 | in_review (blocked by #12) | awaiting_approval | H `waive_finding` × n | 0 open blocking afterwards | Clear flag; `notify` |
| 15 | awaiting_approval | merging | H `approve(headSha)` | `headSha` = PR head = last reviewed head; 0 open blocking; CI for that head `success`, `pending` or `none`; PR positively `mergeable` | Insert merge Approval (head, findings snapshot, CI); `merge_pr(matchHeadSha, auto = CI pending)` |
| 16 | awaiting_approval, merging | in_review | R new commit: PR head ≠ last reviewed head | — | Void approval (`new_commit`); `disable_auto_merge` if enabled; `map_findings` to the new head; `reviewRound += 1`; start reviewer |
| 17 | awaiting_approval, merging | in_progress | R CI `failure` on the head | — | One blocking `ci` finding per failed check (deduped by check-run ID); void approval (`ci_failed`); `disable_auto_merge` if enabled; `send_message` fix round to the implementer (resuming its run if it ended) |
| 18 | awaiting_approval | in_progress | H `request_changes(findings)` | At least one finding | Store them as blocking `human` findings; `send_message` fix round to the implementer (resuming its run if it ended). Doesn't count against the cap. |
| 19 | in_review | in_progress | H `request_changes(findings)` | At least one finding | Store them as blocking `human` findings; void approval (`stage_left`); clear review state (end current reviewer round); `send_message` fix round to the implementer (resuming its run if it ended). Doesn't count against the cap. |
| 20 | merging | awaiting_approval | R `merge_pr` failed with `precondition` (head moved, not mergeable) | — | Void approval; `notify`. If the head moved, #16 applies instead. |
| 21 | any but done | done | R PR `merged` | — | Void open approvals; end all runs (`task_done`): `stop_run` headless runs, leave interactive panes to the human; `notify` |
| 22 | any but done, canceled | canceled | H `cancel` | — | `interrupt_run` working runs, `stop_run` headless runs, end runs (`canceled`); void approvals; `disable_auto_merge` if enabled. The PR and branch stay as they are. |
| 23 | canceled | backlog | H `reopen` | PR not merged | Runs stay ended; the next start is a new attempt. |
| 24 | planning … awaiting_approval | backlog | H `move backlog` | — | `interrupt_run` working runs; `stop_run` headless runs; void approvals (`stage_left`). Plan and findings are kept. |

Notes on the rules:

- **Precedence.** An observed merge wins over all commands. For `awaiting_approval`/`merging`, a new
  PR head wins over old-head CI failures or a merge-precondition failure. `mergeable: unknown` is
  insufficient for #10/#15. If GitHub is unavailable when a merge precondition fails, retain the
  failed outbox result and apply #16 or #19 after a fresh read.
- **Deferred work and capacity.** The stage can change while its desired run or fix message waits.
  Capacity and executor ordering are defined in §5.4. The executor must honor persisted dependencies
  and canceled intents, rather than treating an action array as freely parallelizable work.
- **Review evidence.** `review.headSha` is the round's immutable target; `lastReviewedHead` advances
  only on a valid review submission. `verdictIds` captures addressed/disputed findings at round start.
  The prior completed round's blocking count is used for convergence. The MCP boundary verifies blob
  existence and line bounds before constructing drafts; core verifies each anchor's head, path, side,
  range and blob identity against the submission.
- **Clean tree.** The git adapter excludes ignored files, including `.task/` and ignored build output,
  and supplies all offending paths in `dirtyPaths` for actionable `guard_failed` details.

- **Plan-approval gate.** Its own stage (#5, #7, #8), so "waiting for the human" is a visible state with its
  own CAS and audit row. The board may draw it inside the Planning column.
- **Round cap.** The round counter counts reviewer runs. The cap limits going *back* to `in_progress`
  (#11 against #12). A re-review after a new commit (#16) always runs, because nothing merges unreviewed,
  and counts as a round. A human's `request_changes` (#18) is not capped.
- **Done only when the merge is observed.** `merge_pr` succeeding moves nothing; #20 fires only when a
  GitHub read shows `state: merged`. That covers merges made on github.com, from any stage.
- **Approval voiding.** Any change to the head, CI failing, or leaving the stage voids a merge approval.
  Voiding is a new column value, never a delete. An approval with auto-merge enabled is disarmed
  (`disable_auto_merge`) before anything else happens.
- **GitHub comments.** Human PR comments are imported as findings (source `github`, deduped by
  comment ID). They block only when their review's state is `changes_requested`; otherwise they're `minor`.
- **Moving a card by hand.** Only the moves in the table are allowed. Anything else is rejected with
  `wrong_stage`, rather than guessed at.

## 3. Flags and attention

Flags never change the stage. While `blocked` or `failed` is set, reconcile starts no runs and schedules
no retries for the task. MCP submissions from the current run and human commands still go through.

| Flag | Set when | Cleared when |
|---|---|---|
| `blocked: dependencies` | In `todo` with an unmerged `blockedBy` task | All of them are merged |
| `blocked: question` | `ask_human` with `blocking: true` | Human `answer_question` (the answer is sent as a message) |
| `blocked: review_round_cap` / `review_not_converging` | #12 | #13, #14, or cancel |
| `blocked: provider_cooling_down` | Codex: `usageAllowed: false` or a `rateLimitExceeded`/`usageLimitExceeded` error. Claude: StopFailure with a rate-limit error. Only for a run that needs to start or continue. | `until` passes and a fresh snapshot allows usage |
| `blocked: pr_closed` | PR read as `closed` without merge | PR reopened (read), or cancel |
| `failed: retries_exhausted` | A run failed `maxAttempts` (3) times | Human `retry` (new monotonic attempt, retry-budget offset resets) |
| `failed: non_retryable_error` | Provider error with no retry (for example, Codex `willRetry: false` with an unsupported model) | Human `retry` |
| `failed: action_failed` | An action returned `fatal` | Human `retry` |

**Retrying automatically is for headless runs only.** A failed or crashed headless run keeps its row,
gets `retryAt` and a `schedule` action, and relaunches as `attempts + 1` against the same session ID
(§1 "Run"): `start_run` with `resume: true` while the provider still has the session, otherwise
`sessionEpoch + 1` and a fresh one. Retries within `retry.maxAttempts` (3) set no flag; exhausting them
sets `failed: retries_exhausted`.

**An interactive run is never relaunched automatically.** From outside, a human closing the pane and a
crash look identical: the `claude agents` entry disappears with no SessionEnd (spike 02). Reopening a
terminal someone deliberately closed is worse than asking, so the run ends with `vanished`, the task gets
`run_vanished` attention, and the human's `retry` relaunches it (resuming the session when the provider
still has it). Closing a Codex pane is different: it only detaches, and the thread keeps running (§4).

**Attention** is derived on every reconcile by `deriveAttention`, which `packages/core` exports as a
pure function so the UI renders the same rule instead of re-implementing it. A task needs the human
while any of these reasons holds:

| Reason | Condition |
|---|---|
| `plan_needs_approval` | Stage `plan_approval` |
| `needs_approval` | Stage `awaiting_approval` |
| `question` | An unanswered `ask_human` question (blocking or not) |
| `provider_permission` / `provider_input` | A live run's `blockedOn` is `permission` / `input` |
| `blocked` | `blocked` is set, except for `dependencies` and `provider_cooling_down`, which just wait |
| `failed` | `failed` is set |
| `run_vanished` | An interactive run's session disappeared. Loom won't relaunch it; the human does. |
| `stalled` | A run is `working` with no provider activity for `stallAfterMs`. Nothing is killed. |
| `status_unknown` | A run has been `unknown` for longer than `unknownGraceMs` |
| `over_budget` | Time in stages `planning` through `awaiting_approval` exceeds `budgetMinutes` |

`Attention` keeps a `since` per reason: `reasonSince` has exactly one entry per current reason, each
the time that reason first appeared and has held since, and `since` is the earliest of them. A queue
sorts by how long each thing has waited, which a single timestamp for the whole set cannot answer
once a second reason appears. `reasonSince` is additive, so a row written before it existed falls
back to the set's `since`.

Terminal tasks (`done`, `canceled`) suppress attention while retaining historical questions and failures.
Uncertain delivery uses `provider_input` attention plus a notification. `activeElapsedMs` accumulates
only time in `planning`, `plan_approval`, `in_progress`, `in_review`, and `awaiting_approval`; parked,
queued, merging and terminal time do not count. The store must reload this counter and its accounting
timestamp instead of recomputing elapsed time from `stageEnteredAt`.

## 4. Run status

Status comes from the provider's own channel. The terminal is never parsed. The pane host supplies no
agent state at all — it has none to give — so an unavailable provider reading leaves the run `unknown`
no matter what the pane looks like. Its one contribution is a native fact: a pane that is `dead` before
any provider evidence proves the launch failed, which turns `starting` into `ended` / `vanished`.
`status` and `lastTurn.outcome` are separate: an idle thread can have a failed last turn.

### Codex (spike 01)

Input: a `thread/read` or `thread/resume` snapshot on the coordinator's own app-server. Notifications
(`turn/*`, `item/*`, `thread/status/changed`, `serverRequest/resolved`) are hints to take a new snapshot.

| Snapshot | `status` / `blockedOn` | Notes |
|---|---|---|
| `active`, no flags, turn `inProgress` | `working` | |
| `active` + `waitingOnApproval` | `blocked` / `permission` | Keep request ID and generation until the provider resolves it. |
| `active` + `waitingOnUserInput` | `blocked` / `input` | Keep `isBlocking` as reported; attention either way. |
| `idle`, last turn `completed` | `idle` | |
| `idle`, last turn `interrupted` | `idle` | A running subprocess may still be alive. |
| last error `willRetry: true` | `working` | Keep the error detail. |
| `systemError`, or last turn `failed` with `willRetry: false` | `failed` | Retry policy; a non-retryable kind sets `failed` straight away. |
| `rateLimitExceeded`/`usageLimitExceeded`, or `usageAllowed: false` | `blocked` / `rate_limit` | Sets `provider_cooling_down`. A bare `account/rateLimits/updated` only triggers `refresh`. |
| Reading unavailable (socket closed) | `unknown` | Never `idle` or `failed`. Reconnect, then `thread/resume`. |
| `notLoaded` on our server | `unknown` | `thread/resume` hydrates it. **Provisional (spike 05).** |

A thread Loom didn't start on its own server (plain `codex` in the worktree) is an external session.
It is observe-only: Loom never resumes it on a second server or derives its status from disk.

Closing an interactive Codex pane only detaches the attach client; the thread keeps running on the
coordinator's app-server, so the run continues and Loom offers to reattach rather than relaunching. If
the thread itself is gone (absent from the server and not resumable), the run ends with `vanished` and
raises attention instead of retrying.

### Claude (spike 02)

Input: the session's `claude agents --json` entry (owner of live status), refined by folded hooks. Poll
`claude agents` on every hook and every 1–2 s while a Loom-launched session is busy or waiting.

| `claude agents` | Hooks | `status` / `blockedOn` | Notes |
|---|---|---|---|
| `busy` | — | `working` | Also covers approval: no hook fires when a permission is approved. |
| `waiting` | Pending AskUserQuestion | `blocked` / `input` | |
| `waiting` | Anything else | `blocked` / `permission` | Don't wait for the Notification; it's 6 s late. |
| `idle` | — | `idle` | An Esc interrupt shows only here. |
| absent (after being present) | SessionEnd seen | `ended` | |
| absent, headless | no SessionEnd | `failed` (crash) | Retried automatically: `claude --resume <id> --settings …`. |
| absent, interactive | no SessionEnd | `ended`, reason `vanished` | Indistinguishable from a human closing the pane, so Loom never relaunches it: attention `run_vanished`, and the human's `retry` relaunches (§3). |
| absent (never present) | — | `starting` | Unless the run's pane is dead, which proves the launch failed: `ended` / `vanished`. A folder-trust dialog is indistinguishable from a slow start; the stall attention surfaces it. |
| any | StopFailure | `failed`; a rate-limit error → `blocked` / `rate_limit` | StopFailure is untested (spike 02). |
| reading unavailable | — | `unknown` | |

Subagent events with an empty `agent_type` are ignored. Headless (Agent SDK) runs add the process's
exit: an error exit is `failed`; a clean exit after the run submitted is `ended`. Sessions with
`kind: background` are external and observe-only.

## 5. Reconciler contract

Types: [`reconcile.ts`](../../packages/core/src/reconcile.ts),
[`observations.ts`](../../packages/core/src/observations.ts), [`actions.ts`](../../packages/core/src/actions.ts).

```ts
type Reconcile = (state: TaskState, observations: Observations) => ReconcileResult;

interface ReconcileResult {
  next: TaskState;               // task, worktree, runs, messages, questions, findings, approvals, artifacts
  actions: Action[];
  transitions: Transition[];     // new audit rows
  inputs: InputDisposition[];    // one per consumed input: accepted (with the MCP reply) or rejected
  capacityVersion?: number;      // CAS required for capacity reservations/releases; absent otherwise
}
```

It is pure: no clock (`observations.now`), no randomness (§1 "IDs"), no I/O.

### 5.0 Required TaskState context

The store loads all original entity collections plus **every** field below in the same read transaction.
None may be omitted. Null is a known lifecycle state, not a substitute for missing persisted data.
The coordinator initializes a new task with the initial values shown, core updates them, and the store
persists/reloads each returned value. `config` is supplied separately by the coordinator at runtime.

| Field | Type / initial value | Meaning and supplier |
|---|---|---|
| `consumedInputIds` | `InputId[]`, initially `[]` | Store supplies consumed inbox receipt IDs, including rejected inputs. Replay protection must survive restart; only archive when those IDs can no longer be replayed. |
| `plan` | `(Plan & {version, accepted}) \| null`, initially null | Store supplies latest submitted plan content and its acceptance state; accepted plans survive parking. It must agree with plan artifact version/content. |
| `review` | `{headSha, lastReviewedHead, previousBlocking, verdictIds} \| null`, initially null | Store supplies current round context. `lastReviewedHead: null` means no completed review; `previousBlocking: null` means no prior completed round. `verdictIds: []` means no findings require verdicts. |
| `desiredRun` | `{role, round, resume} \| null`, initially null | Store supplies a deferred launch/resume intent. Null means none is pending; it is not inferred from the board stage. |
| `activeElapsedMs` | `number`, initially 0 | Store supplies accumulated active-stage budget time in milliseconds. |
| `budgetObservedAt` | `IsoTime`, initially `task.createdAt` | Store supplies the last accounting time, used with this pass's `observations.now`; never reset on reload. |
| `progress` | `{runId, summary, stepIndex, at} \| null`, initially null | Store supplies latest accepted progress report; `stepIndex: null` means not tied to a plan step. |
| `artifactContents` | `Partial<Record<ArtifactKind, unknown>>`, initially `{}` | Store supplies contents matching the loaded latest artifact metadata. A missing kind means no artifact of that kind exists; missing content for an existing artifact is a load error. Validate each kind at the boundary. |

Collections in `TaskState` must include every row the next reconcile can reference: latest artifacts
and matching contents, current/deferred runs, outstanding messages/questions, input receipts, and
outbox payloads/dependencies/retry receipts. Returned ended runs, answered questions, failed messages
and voided approvals are durable updates even when a later snapshot filters them from active views.
Do not prune an outbox receipt while a live intent/dependency or a replayable result can reference it.

### 5.1 One pass

1. `reconcile(taskId)` is enqueued by hints, new inputs, `schedule` timers and a full resync about every
   60 s. At most one pass per task runs at a time; enqueues during a pass coalesce into one more pass.
2. Load `TaskState` in one read transaction.
3. Read observations from the owners, outside any transaction: the worktree, the PR (conditional
   request), every run that hasn't ended, external sessions in the worktree, capacity, dependencies and
   unconsumed inputs.
4. Call `reconcile`.
5. Commit in one write transaction (§5.4). If the compare-and-set fails, drop the result and go back
   to step 2 (up to 3 times, then re-enqueue).
6. The executor runs eligible pending outbox actions after dependency success and cancellation checks.
   Each result is persisted as an `action_result` input, which enqueues step 1.

### 5.2 Observations

| Observation | Owner and read | Used for |
|---|---|---|
| `git: Reading<GitWorktreeObservation>` | git: HEAD, branch, dirty, ahead/behind, `merge-tree` conflicts, remote head | Guards #9, #10, #15; new-commit detection |
| `github: Reading<PullRequestObservation \| null>` | GitHub, conditional GET with ETag | PR head, state, mergeability, CI, reviews and human comments |
| `runs[].provider` | Codex thread snapshot or Claude session (agents entry + hooks + headless exit) | §4 status, pending requests, delivery confirmation |
| `runs[].pane` | Pane host (interactive runs) | Native pane facts only: pid, command name, `dead`, exit status, start path. Never run status |
| `externalSessions` | `claude agents --json`, Codex thread list, both joined on realpath `cwd` | Recorded as `origin: external` runs |
| `capacity` | Coordinator (across tasks) | Global and per-provider caps, cooling-down providers; `version` for CAS |
| `dependencies` | Coordinator (other tasks) | `blockedBy` |
| `inputs: Input[]` | Coordinator inbox | Human commands, validated MCP calls, action results |

`Reading.ok: false` means the owner couldn't be read. Reconcile treats that fact as unknown: no
transition whose guard needs it, and runs whose provider can't be read become `unknown`.

Required evidence is appended after the original fields in each observation interface:

| Field | Type / empty or null semantics | Who supplies it |
|---|---|---|
| `RunObservation.resumable` | `boolean \| null`: true means provider-confirmed resumability, false means confirmed unable to resume, null means no authoritative determination yet | Provider adapter/integration boundary, assembled by the coordinator. After a missing Codex reading, perform a native resume/existence check; do not leave null indefinitely or infer false from socket failure or pane disappearance. An unavailable read remains `unknown` regardless of this field. |
| `RunObservation.activityAt` | `IsoTime \| null`: latest known provider activity timestamp, or null if there is no evidence | Provider adapter, from native events/state changes; never use a no-change poll's fetch time. The coordinator persists receipt evidence across observer restarts. Claude's folded `lastEventAt` remains an additional source when this field is null. |
| `GitWorktreeObservation.dirtyPaths` | Required `string[]`: all tracked/non-ignored untracked dirty paths; `[]` means clean | Git adapter from git status metadata, consistent with `dirty`. Failed status collection means a failed `Reading`, not an empty array. |
| `GitWorktreeObservation.reachableCommits` | Required `Sha[]`: commits verified reachable from this reading's HEAD; `[]` means none verified | Git adapter/boundary must cover every non-null fixing commit in pending `resolve_finding` inputs, or return full HEAD ancestry. The coordinator must not submit a guard check with unqueried candidates silently represented as an empty list. Collection failure means a failed git `Reading`. HEAD itself is accepted directly. |
| `CiCheck.id` | Required `string`: stable GitHub check-run ID, including in approval CI snapshots | GitHub adapter, stringifying the native ID. Missing identity invalidates the reading; never synthesize it from a name or head SHA. |

The boundary validates both field presence and these semantics before core sees a typed value. A
store/adapter must not manufacture empty arrays/nulls to paper over missing data. `resumable: null`
is intentionally uncertainty and must trigger further owner reads when recovery needs it.

### 5.3 Actions and how results come back

Every action result comes back the same way: the executor writes an `action_result` input keyed by the
action key, and the next pass consumes it. Reconcile never assumes an action worked just because it
asked for it.

| Action | Executor | Success output → what the next pass does |
|---|---|---|
| `create_worktree` | git | `{path, headSha, baseSha}` → Worktree row; `task.worktreePath` |
| `write_task_files` | git | — |
| `open_workspace` | pane host | `{workspaceId}` → `worktree.paneWorkspaceId` |
| `start_run` | by provider and mode (below) | Carries `{runId, attempt, sessionEpoch, sessionId, resume}`. `resume: true` reuses the session (Claude `--resume <id>`, Codex `thread/resume`); `resume: false` starts a fresh one (Claude `--session-id <derived>`, Codex `thread/start`, which assigns the ID). Returns `{sessionId, codexGeneration, pane}` → run row. For Codex, this is what unlocks the first `send_message` (principle 7). |
| `send_message` | by provider and mode | `{transportRef}` → message `sent`. `delivered` comes only from observation (§5.5). |
| `interrupt_run` | by provider and mode | — (the run's status confirms it) |
| `answer_provider_request` | Codex `answerRequest` (current generation only) | — (`serverRequest/resolved` and a new snapshot confirm it) |
| `stop_run` | Codex `unsubscribe`; SDK close | — |
| `push_branch` | git | `{remoteHeadSha}` |
| `open_pr` | GitHub | `{number}` → `task.prNumber` |
| `merge_pr` | GitHub | `merged` or `auto_merge_enabled`. Neither moves the task; #20 waits for the merge to be observed. |
| `disable_auto_merge` | GitHub | — |
| `map_findings` | git (hunks, renames, blobs) and core's pure mapper | New `FindingLocation` versions |
| `refresh` | the named owner | — (the fresh read is in the next pass's observations) |
| `schedule` | coordinator timer | — (the timer enqueues a pass) |
| `notify` | desktop notification or UI | — |

A failed result carries `retryable`, `precondition` or `fatal`. `retryable` gets a new attempt after
backoff (`<key>#<n>`). `precondition` means the world moved: re-read and decide again. `fatal` sets
`failed: action_failed`.

| | Codex headless | Codex interactive | Claude headless | Claude interactive |
|---|---|---|---|---|
| start | `thread/start` (read-only sandbox for reviewers) | `thread/start`, then a pane running `codex resume <thread> --remote unix://…` | Agent SDK with Loom's session ID | A pane: `claude --session-id <id> --settings <per-run> --mcp-config <per-run>` |
| send | `turn/start`, or `turn/steer` with `expectedTurnId` | the same, through the app-server, not the pane | SDK | `pasteText`, gated on provider status |
| interrupt | `turn/interrupt` | `turn/interrupt` | SDK interrupt | `sendKey Escape` |
| resume | `thread/resume` | `thread/resume`, then reattach the pane | SDK resume | A pane: `claude --resume <id> --settings <per-run> --mcp-config <per-run>` |

#### Outbox record and execution rules

In addition to `key`, `kind`, `status`, `attempts`, `createdAt`, and nullable `finishedAt`, retain:

| Field | Supplier / meaning |
|---|---|
| `action` | Core emits the full payload; executor/store must retain it for result routing and retry. Its type permits omission only for receipt rows no future result/retry needs; a result without a matching payload is rejected. |
| `retryAt` | Core's backoff deadline; absent means no action retry scheduled. |
| `dependsOn` | Core's ordered intent dependencies; absent/empty means none. Execute only after all dependency keys succeeded. This enforces push-before-PR/reviewer launch and disarm-before-new work, including across passes. |
| `retriedBy` | Core's replacement retry key; absent means not replaced. Pending dependents are rewired to that key. |
| `retryBaseAttempt` | Core's retry-budget offset after a human retry; absent means 0. Attempt numbers stay monotonic. |
| `error` | Executor error retained by core on failed results, including preconditions that need later fresh evidence; absent means no recorded error. |

Status is `pending`, `running`, `succeeded`, `failed`, or `canceled`. The store persists all changes
atomically with task state. Before side effects the executor rechecks eligibility and current intent;
never launch superseded/canceled work. Cancellation retires pending start/send/request actions, and
parking/cancel/Done retires obsolete task work. Already-running work may finish, but canceled rows'
late results cannot resurrect state. A canceled generic intent requested anew receives a suffixed key
instead of reusing the old receipt. These guarantees do not undo an external side effect already made.

### 5.4 Idempotency and compare-and-set

1. **Deterministic.** The same state and observations give the same result.
2. **Fixed point.** Running reconcile again on `next` with the same owner readings (and the inputs now
   consumed) produces no transitions, and only actions whose keys are already in the outbox.
3. **Action keys name the intent**: `start_run:<runId>#<attempt>`, `send_message:<messageId>`,
   `push_branch:<taskId>:<sha>`, `open_pr:<taskId>:<branch>`, `merge_pr:<approvalId>`,
   `map_findings:<taskId>:<headSha>`, `schedule:<taskId>:<why>:<at>`. The outbox's key is unique, so
   emitting the same intent twice is a no-op.
4. **Actions run at least once.** After a crash, pending outbox rows run again. So every executor checks
   the owner before acting: an existing worktree on the branch, an existing PR for the branch, a session
   already live under that ID, a remote head already equal to the SHA. Merges are safe through
   `--match-head-commit`. A run's session ID is fixed for its epoch, so a repeated `start_run` finds that
   same session and adopts it instead of starting a second one.
5. **Inputs are consumed exactly once**, in the same transaction as the compare-and-set. A pass that
   loses the race consumes nothing.
6. **Stage CAS**: `UPDATE tasks SET …, version = version + 1 WHERE id = ? AND version = ?`.
   Core bumps the version once when owned state changes. No-op detection compares plain records
   structurally, ignoring object key insertion order while preserving array order and primitive values.
   It short-circuits equal references/first differences and does not serialize the entire state or findings
   projection. Worst-case structural comparison is still linear in the compared data; there is no claim
   of constant-time reconciliation. The same equality rule prevents unnecessary findings artifact versions.
7. **Capacity CAS (resolved note 13.1).** The coordinator supplies global/per-provider counts of
   `starting`/`working`/`blocked` runs and pending work reservations, excluding idle implementers.
   Idle implementers keep their sessions through review/approval without holding a slot. Sending work
   to an idle run re-acquires a slot; its pending fix message waits when full. Count a queued launch or
   accepted send reservation exactly once until native status confirms it, rather than freeing it during
   the transport gap. An ending active planner can transfer its slot in the same commit.
   A result with `capacityVersion` requires CAS on that version for starts, idle-run sends and ends;
   the coordinator also bumps its version when authoritative observation reconciliation changes these
   counts. Pure reads of capacity do not reserve a slot. Two tasks cannot take the last slot concurrently.
8. **Caches never decide.** Guards use this pass's readings. Cached fields (C) are for the UI and for
   diffing (for example, "the head changed since the last pass").
9. **Crashes don't prove a command didn't run** (spike 01). Before a new attempt after a crash or
   interrupt, re-read the worktree and include what's there in the attempt's first message.

### 5.5 When a message counts as delivered

Never on the pane host's `"written"`, and never on a transport response alone.

| Path | `sent` when | `delivered` when |
|---|---|---|
| Codex `turn/start` | the response returns a turn ID | `turn/started` for that turn, or a snapshot containing it (resume doesn't replay `turn/started`) |
| Codex `turn/steer` | the response returns the expected turn ID | a user-message item with the message's text hash appears in that turn. **Provisional**: seen in spike 01, not a documented guarantee. |
| Claude (interactive or headless) | `pasteText` returns `"written"`, or the SDK accepts it | `UserPromptSubmit` for the session whose normalized `prompt` hash matches (tabs → 4 spaces, CRLF → LF) |

Several prompts can join one Claude turn and share a `prompt_id`; each is still matched by its own
`UserPromptSubmit`. If a message is still not delivered after `deliveryTimeoutMs`: when the provider is
idle and shows no new turn, resend once under the same message ID; otherwise add attention. **A paste is
gated on the provider's status**: in spike 06 a paste into a pending permission dialog approved the
command instead of delivering a prompt, so `pasteText` is only called for a run the provider reports as
idle or working, and the state-check/input race is treated as uncertain delivery, never auto-retried.
Loom never generates text that starts with `/` or `!`, and the pane host refuses it anyway (the message
fails and the human is notified).

The timeout resend keeps the message ID but uses `send_message:<id>#2`, since the first action key
already succeeded. Transport failures separately use bounded action retries with suffixed keys.
Persist `via`, expected/baseline turn IDs and delivery attention; confirmation must match the session
and cannot use a receipt older than the send. Serialize outstanding messages per run until native
delivery is known. Ending a run retires its undelivered messages, so stale prompts cannot block a
resumed attempt. For ambiguous timeout delivery, notify and set existing `provider_input` attention.
Native executor idempotence checks remain necessary: core never infers delivery from transport success.

## 6. Adapter interfaces

The TypeScript is in [`adapters.ts`](../../packages/core/src/adapters.ts). It has only the methods
that the observations in §5.2 and the actions in §5.3 need. Shared rules: every adapter validates external
output with zod before returning a core type; `subscribe` delivers hints (`{source, worktreePath,
sessionId}`) that only enqueue passes; nothing parses terminal output.

| Adapter | Reads (observations) | Writes (actions) |
|---|---|---|
| `GitAdapter` | `realpath`, `readWorktree`, `changedFiles` (NUL-delimited metadata, renames, hunks), `readBlob` | `createWorktree`, `push` (refuses any head except the expected one; never forces), `writeTaskFiles` (and `.git/info/exclude`) |
| `GitHubAdapter` | `findPullRequest` (conditional, ETag) | `openPullRequest` (idempotent), `mergePullRequest` (squash, `--match-head-commit`, optional `--auto`), `disableAutoMerge` |
| `PaneHost` | `getPane`, `listPanes`, `listClients`, `subscribe` | `ensureWorkspace`, `ensurePane` (allowlisted environment, no shell), `pasteText` (refuses `/` and `!`; returns only `"written"`), `sendKey` (Escape), `attachArgs`, `closePane` |
| `CodexAdapter` | `readThread`, `resumeThread`, `readRateLimits`, `generation`, `subscribe` | `startThread`, `startTurn`, `steerTurn`, `interruptTurn`, `answerRequest` (rejects a stale generation), `unsubscribe`, `attachArgs` |
| `ClaudeAdapter` | `listSessions` (`claude agents --json`), `hookSummary`, `headlessState`, `subscribe` | `interactiveArgs`, `startHeadless`, `sendHeadless`, `interruptHeadless` |

Deliberately missing: attach and takeover for the embedded terminal (`apps/desktop` owns them; spike 03),
Codex `review/start`, and anything that reads a pane's screen.

## 7. Loom MCP tools

Types: [`mcp.ts`](../../packages/core/src/mcp.ts). `packages/mcp` will hold the zod schemas, with a
type-level test that they equal these types.

**Identity.** Each run gets its own MCP endpoint token in its per-run config. Claude ignores
`mcpServers` in a `--settings` file (2.1.269), so the token goes in the run's MCP config —
`--mcp-config <per-run>` for an interactive run, `mcpServers` passed to the Agent SDK for a headless
one — beside, not inside, the settings file that carries the hooks. Codex takes it with `-c`. The token
maps to the run, and through the run to the task, so no tool takes a task or run ID, and an agent can't
act on another task.

**Flow.** Validate the input against the schema → resolve the token to a run → persist it as an `mcp`
input (assigning finding and question IDs, and building each finding's full anchor from the reviewed
blobs) → run a reconcile pass for the task → answer with that input's disposition. `get_task_context` is
read-only and never becomes an input.

| Tool | Role and stage | Input | Output | Guards (else `guard_failed`) |
|---|---|---|---|---|
| `get_task_context` | any run | `{}` | task, role, run, worktree, brief, plan, decisions, handoff, role-filtered findings, test results, answered questions, WORKFLOW commands | — |
| `submit_plan` | planner / `planning` | `{plan: Plan}` | `{planVersion, next}` | Plan has a goal, at least one step and one acceptance criterion |
| `report_progress` | any current run | `{summary, stepIndex, decisions[], testResults[]}` | `{recorded}` | `stepIndex` null or within the plan; nonempty test results need a fresh git HEAD |
| `ask_human` | any current run | `{question, options[], blocking}` | `{questionId, delivery: "message"}` | — |
| `submit_for_review` | implementer / `in_progress` | `{headSha, summary, testResults[], handoff}` | `{round}` | `headSha` = HEAD; clean tree; ahead of base; every finding `addressed` in this round names a commit |
| `submit_review` | reviewer / `in_review` | `{reviewedSha, summary, findings[], verdicts[], testResults[]}` | `{round, openBlocking, next}` | `reviewedSha` = round head; locations exist in that commit; a verdict for every `addressed`/`disputed` finding |
| `resolve_finding` | implementer / `in_progress` | `{findingId, resolution: fixed \| disputed, note, commitSha}` | `{status}` | Finding is `open` and belongs to the task; `fixed` needs a commit reachable from HEAD |

Errors: `invalid_input`, `unknown_run`, `stale_run` (the run was superseded or ended), `wrong_stage`,
`guard_failed`. Each has `details`: one line per failed check, written for the agent to act on.
`ask_human` answers arrive later as a user message quoting the question ID, and in `get_task_context`.

## 8. Storage

SQLite in WAL mode (better-sqlite3), one database per instance data directory (`LOOM_INSTANCE`).
Artifact content is committed with its metadata (the schema sketch below uses `artifacts.content`),
then materialized beside the database at `tasks/<taskId>/<kind>/v<N>.json`. JSON columns are validated
with zod when read. Times are ISO-8601 text. The schema is a contract sketch for the future store,
not a migration already shipped in Phase 1b.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, capacity_version
CREATE TABLE repos (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, github TEXT NOT NULL,
  base_branch TEXT NOT NULL, default_providers TEXT NOT NULL, serial_tests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tasks (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL, description TEXT NOT NULL,
  stage TEXT NOT NULL, stage_entered_at TEXT NOT NULL, version INTEGER NOT NULL,
  blocked TEXT, failed TEXT,                                   -- JSON flag or NULL
  require_plan_approval INTEGER NOT NULL, review_round INTEGER NOT NULL,
  review_round_cap INTEGER NOT NULL, providers TEXT NOT NULL, budget_minutes INTEGER,
  worktree_path TEXT UNIQUE, branch TEXT, pr_number INTEGER,
  attention TEXT NOT NULL,                                     -- derived
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE task_context (task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  plan TEXT, review TEXT, desired_run TEXT, progress TEXT,        -- JSON; SQL NULL maps to explicit null
  active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
  budget_observed_at TEXT NOT NULL);                            -- initialize to task.created_at
CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id),
  blocked_by TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, blocked_by));
CREATE TABLE worktrees (path TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  repo_id TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, base_sha TEXT NOT NULL,
  port_slot INTEGER UNIQUE, pane_workspace_id TEXT, git_cache TEXT,
  created_at TEXT NOT NULL, removed_at TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, origin TEXT NOT NULL,
  worktree_path TEXT NOT NULL, round INTEGER NOT NULL, attempts INTEGER NOT NULL, model TEXT NOT NULL,
  session_id TEXT, session_epoch INTEGER NOT NULL DEFAULT 0, codex_generation INTEGER, pane TEXT,
  status TEXT NOT NULL, blocked_on TEXT, last_turn TEXT, pending_requests TEXT NOT NULL,
  last_activity_at TEXT, retry_at TEXT, launched_at TEXT, ended_at TEXT, end_reason TEXT,
  seen_at TEXT, unknown_since TEXT, observed_attempt INTEGER, retry_base_attempt INTEGER DEFAULT 0,
  UNIQUE (provider, session_id));
CREATE INDEX runs_live ON runs(task_id) WHERE ended_at IS NULL;
CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), purpose TEXT NOT NULL,
  text TEXT NOT NULL, text_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
  transport_ref TEXT, sent_at TEXT, delivered TEXT,
  via TEXT, expected_turn_id TEXT, baseline_turn_id TEXT, delivery_attention INTEGER NOT NULL DEFAULT 0);
CREATE TABLE questions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL, blocking INTEGER NOT NULL, asked_at TEXT NOT NULL, answer TEXT, answered_at TEXT);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, content TEXT NOT NULL, -- JSON bytes hashed by core
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (task_id, kind, version));
CREATE TABLE findings (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, round INTEGER NOT NULL,
  source TEXT NOT NULL, external_id TEXT, created_by_run_id TEXT,
  severity TEXT NOT NULL, blocking INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL, reopen_count INTEGER NOT NULL DEFAULT 0,
  anchor TEXT,                                                 -- JSON, written once
  resolution TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (task_id, source, external_id));
CREATE TABLE finding_locations (finding_id TEXT NOT NULL REFERENCES findings(id),
  version INTEGER NOT NULL, head_sha TEXT NOT NULL, path TEXT, blob_oid TEXT, side TEXT NOT NULL,
  start_line INTEGER, end_line INTEGER, status TEXT NOT NULL, mapped_at TEXT NOT NULL,
  PRIMARY KEY (finding_id, version));
CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
  plan_version INTEGER, head_sha TEXT, findings_snapshot TEXT, ci TEXT,
  created_at TEXT NOT NULL, voided_at TEXT, void_reason TEXT);
CREATE TABLE transitions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at TEXT NOT NULL,
  from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, flags TEXT NOT NULL, trigger TEXT NOT NULL,
  reason TEXT NOT NULL, task_version INTEGER NOT NULL);
CREATE TABLE inbox (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, received_at TEXT NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, consumed_at TEXT, disposition TEXT);
CREATE TABLE outbox (key TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, result_input_id TEXT,
  retry_at TEXT, depends_on TEXT NOT NULL DEFAULT '[]', retried_by TEXT,
  retry_base_attempt INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE claude_hooks (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  event TEXT NOT NULL, prompt_id TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE github_cache (repo_id TEXT NOT NULL, branch TEXT NOT NULL, etag TEXT,
  pr TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (repo_id, branch));
```

The store reconstructs required `TaskState` fields explicitly: `task_context` supplies plan/review/
desired run/progress and budget counters; latest `artifacts` rows supply `artifactContents`; consumed
`inbox` rows supply `consumedInputIds` (including rejected dispositions). Empty values are only valid
for their documented initial/absent states. Missing rows or version/content disagreement must fail
loading, rather than silently falling back to `{}`, `[]`, zero or null. Materialization must read the
exact artifact version named by an action even when a newer version now exists. Retain outbox
payloads/error/retry/dependency receipts according to §5.3 and replayable inbox receipts according to §5.0.

`claude_hooks` is a receipt log, not a second owner: hooks can't be re-read from Claude, so the
coordinator keeps them to fold into `ClaudeHookSummary` after a restart. It's pruned after 7 days.

**Migration policy**

- Numbered files in `packages/store/migrations/NNNN_<name>.sql`. Each runs in its own transaction at
  startup and bumps `meta.schema_version`. A merged migration is never edited.
- A migration only adds: tables, indexes, and columns that are nullable or have a default. Nothing is
  renamed, retyped or dropped in the release that stops using it.
- Removal is a later migration, at least one release after no code reads the old column or table.
  That migration is marked `breaking`.
- Because changes are additive, an older build can open a newer database, which is what makes
  `loom release` rollback work. A build refuses to start only when the database has a `breaking`
  migration it doesn't know.
- Back up the database (SQLite backup API) before applying migrations.
- Migrations get the `core` label and its review rules. Dev and prod never share a data directory.

## 9. fake-agent

`packages/fake-agent` implements the provider side of `CodexAdapter`, `ClaudeAdapter` and `PaneHost`
in memory, plus a fake `GitHubAdapter`, all driven by scenarios. Its agents call the real Loom MCP
server. Tests run the real core, store and executor against it with a fake clock, and never start a
real agent.

```ts
interface Scenario {
  name: string;
  /** Which run this script plays: matched on provider, role and mode when Loom starts one. */
  agent: { provider: "codex" | "claude"; role: Role; mode: RunMode; attempt?: number };
  steps: Step[];                                  // run in order; each waits for the one before
}

type Step =
  | { expect: "message"; match?: string; timeoutMs?: number } // wait for Loom's prompt; confirm it the provider's way
  | { status: "working" | "idle" }                            // native events (turn/started, busy/idle)
  | { request: "approval" | "question"; summary: string; expect: "accept" | "decline" | "answer" }
  | { tool: McpToolName; input: unknown; expectError?: McpErrorCode }
  | { git: "commit"; files: Record<string, string>; message: string }
  | { turn: "completed" | "interrupted" | "failed"; error?: { willRetry: boolean; kind: string } }
  | { rateLimit: { resetsInMs: number } }
  | { crash: true }                                           // Claude: entry vanishes, no SessionEnd; Codex: socket closes
  | { stall: number }                                         // no events for this many ms (fake clock)
  | { dropDelivery: true }                                    // transport says ok; the provider never confirms
  | { duplicate: "last_event" }                               // replay the last event, to test idempotency
  | { github: "ci"; conclusion: "success" | "failure" | "pending" }
  | { github: "push"; files: Record<string, string> }         // a human pushes to the branch
  | { github: "comment"; body: string; path?: string; line?: number; changesRequested?: boolean }
  | { github: "merge" | "close" };
```

Scenarios are JSON files next to the tests. For example, an implementer with one fix round is:
`expect message` → `status working` → `git commit` → `tool submit_for_review` → `status idle` →
`expect message /findings/` → `git commit` → `tool resolve_finding` → `tool submit_for_review`.
Inputs may use `$HEAD`, `$FINDING_<n>` and `$QUESTION_<n>`, which are replaced at run time. Scenarios are
validated with zod when loaded, and a scenario with steps left over when its run ends fails the test.

## 10. Restart recovery

Verified in [spike 05](../../spikes/05-restart-matrix/FINDINGS.md) and re-measured on tmux in
[spike 06](../../spikes/06-tmux-pane-host/FINDINGS.md), with spikes 01 and 02 for the provider sides.

| Fault | What happens | Reconcile |
|---|---|---|
| Coordinator restart | Providers and the pane host are untouched. | Load SQLite; run `pending` and `running` outbox rows again; `thread/resume` every live Codex run; poll `claude agents`; reconcile every non-terminal task. |
| A client detaches | Nothing: same PIDs, same IDs, turns finish. Other clients stay attached. | None. |
| Pane host stop, crash or kill | Every pane process dies. The host has no restore feature, and needs none. Pane IDs restart at `%0`, so every stored `PaneRef` from the old generation names nothing. | Interactive runs go `unknown`, then are relaunched from stored state: `ensureWorkspace` + `ensurePane` with the full stored command line and environment (Claude `--resume <id> --settings … --model …`; Codex `resume <thread> --remote <sock>`). Claude's in-flight turn is lost: re-send the message. A Codex turn completed meanwhile because its app-server is outside the host: read it with `thread/read`. About 30 s to a fresh reply from both. |
| Codex app-server restart | Generation + 1; older request IDs are dropped, never answered. The unfinished turn reads `interrupted`. | Runs `unknown` until `thread/resume`; the interrupted turn is a failed attempt and is re-sent. |
| Claude process dies, host fine | The `claude agents` entry vanishes with no SessionEnd; the pane reads `dead`. | Headless: retry with `--resume`. Interactive: `vanished` and attention; the human relaunches (§3). |

Rules that follow: one Codex app-server per task, as a Loom child process outside the pane host; no
decision is ever derived from a pane; the intended command line and environment of every interactive run
are Loom state, never inferred from a pane's argv.

Still placeholders: `unknownGraceMs` 60 s, `deliveryTimeoutMs` 10 s, `stallAfterMs` 15 min. `claude agents
--json` took up to about 5 s to list a relaunched session, so the grace period must exceed that. Untested:
a machine restart, a Claude permission prompt across a restart, and spooling hooks while the
coordinator is down.

Resume attempts remain bounded by `retry.maxAttempts` (3 by default).

## 11. Out of v1

- Stacked PRs, tasks that span repos, more than one machine, webhooks (polling only).
- Removing worktrees automatically. Loom shows which are safe to remove; the human removes them.
- Taking control of external sessions (hand-started or `claude --bg`); they stay observe-only.
- Pre-trusting worktrees for Claude; the human answers the trust dialog.
- Answering an interactive Claude permission prompt from Loom's UI. It's answered in the terminal;
  Codex approvals can be answered from Loom.
- Switching provider for a run that has started; Codex `review/start` second opinions.
- Cost budgets (only a wall-clock budget, which adds attention); GitHub App identity for agents.
- Phase 5 items: ports and dev servers, overlap warnings, the rebase queue, issue import.

## 12. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Plan approval is its own stage, `plan_approval`. | "Waiting on the human" gets its own CAS, audit row and attention reason. The board can still show it under Planning. |
| 2 | Exhausted retries set `failed`, not `blocked` (also reflected in `architecture.md`). | `blocked` means waiting on something outside Loom; `failed` means Loom's automatic path gave up. The human acts differently on each. |
| 3 | `reviewRound` counts reviewer runs. The cap limits going back to `in_progress`; a re-review after a new commit always runs; `request_changes` isn't capped. | Nothing merges unreviewed, and the human stays in charge of their own requests. |
| 4 | `blocker` and `major` findings block. GitHub comments block only under a `changes_requested` review. A failed CI check becomes a blocking `ci` finding. | Agents choose severity and code chooses what it means (architecture: code decides guards). |
| 5 | CI failing after approval goes to `in_progress`; a new commit goes to `in_review`. | A CI failure needs a fix; a new commit needs a review. |
| 6 | A voided approval disarms auto-merge first (`disable_auto_merge`). | `--auto` could otherwise merge a head the human never approved. |
| 7 | `merge_pr` succeeding never moves a task; only an observed merge does. | Done is derived from GitHub. |
| 8 | Cancel leaves the PR and branch alone. | GitHub owns them. The human closes the PR if they want it closed. |
| 9 | The git adapter creates worktrees; the pane host only opens a session on the path. | Git owns branches, and headless runs shouldn't need a terminal at all. |
| 10 | IDs are derived: run ID `<task>/<role>/<round>`, Claude session = UUIDv5 of `<runId>#<sessionEpoch>`. A retry keeps the row and the session ID; only a session the provider can't resume bumps the epoch. | Keeps reconcile pure, lets a retry actually resume, and makes `start_run` idempotent: a repeat targets the same session. |
| 11 | `ReconcileResult` also returns `transitions` and `inputs`. | The audit log and MCP replies must commit atomically with the state. |
| 12 | Inbox and outbox tables. | Inputs are consumed exactly once; actions run at least once and survive a crash. |
| 13 | Capacity is compare-and-set on a global version. | Reconcile is per task, but caps are global. |
| 14 | MCP identity comes from a per-run token; tools take no IDs. | An agent can't act on another task, or as a superseded run. |
| 15 | `ask_human` returns immediately; the answer comes as a message. | No tool call held open for hours; it works the same for both providers. |
| 16 | Codex steer counts as delivered on the user-message item (provisional). | `turn/steer` joins an existing turn, so there's no `turn/started`. |
| 17 | The pane host supplies no run status, only native pane facts. | Principle 4: anything else would be read off a screen. |
| 18 | Claude hooks are kept as a receipt log. | They can't be re-read; `claude agents` still owns status. |
| 19 | `packages/core` has no runtime dependencies and compiles with `types: []`. Zod schemas live in `packages/mcp` and `packages/protocol`, tested equal to the core types. | Node APIs can't be imported into core by accident, and core stays exhaustively testable. |
| 20 | Flags stop automatic starts and retries, not submissions or human commands. | A submission is still valid work; the human always has control. |
| 21 | Interactive runs are never relaunched automatically. They end as `vanished` and raise attention. | A human closing the pane and a crash are indistinguishable, and reopening a terminal someone just closed is worse than asking. Headless retries are unaffected. |
| 22 | External runs (origin='external') record `model: ''` (empty string). | External runs represent sessions Loom did not launch—a developer ran Claude or Codex in the worktree by hand. Since Loom never chose the model, an empty string records that it is unknown. Preserve it through protocol serialization. |

## 13. Phase 1b review notes and resolution

These notes were raised during design review. Resolutions below are part of the current contract.

| # | Note |
|---|---|
| 1 | **Resolved:** exclude idle implementers from capacity and re-acquire a reservation on their next message. Pending fix messages are the wait state; starts, sends and releases use capacity CAS (§5.4). |
| 2 | **Resolved:** clean means no tracked or non-ignored untracked changes; `dirtyPaths` is required and appears in failed-guard details (§5.2). |
| 3 | **Assigned to the future coordinator/MCP boundary:** load and validate `WORKFLOW.md` for read-only `get_task_context`; it is not a reconcile input or a core I/O action. Cache location and missing/malformed-file policy must be settled in that phase before exposing commands. |
| 4 | **`packages/protocol` is still undrafted.** It's Phase 1's fifth deliverable, and the Phase 4 UI work depends on it. Its snapshot is mostly these entities plus derived views: attention, and the review shell state from spike 04. |
