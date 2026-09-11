# Core design

Phase 1a proposal, for review. The contracts are also written as TypeScript in
[`packages/core/src`](../../packages/core/src) (types only). Phase 1b implements this once it's approved.
Built on [`docs/architecture.md`](../architecture.md) and the findings of spikes 01–04. Anything that
depends on spike 05 (restarts) is marked **provisional**.

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
| `version` | A | Compare-and-set counter; +1 per commit. |
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

One launch of one agent in one role. A retry is a new run (`attempt + 1`); a fix round reuses the
implementer's run and session.

| Field | Own | Notes |
|---|---|---|
| `id` | A | Deterministic: `<taskId>/<role>/<round>/<attempt>`. |
| `taskId`, `role`, `provider`, `mode`, `model` | A | Planner and reviewer are `headless`; implementer is `interactive`. |
| `origin` | A | `loom`, or `external` for a session started by hand in the worktree (observe-only). |
| `worktreePath`, `round`, `attempt` | A | |
| `sessionId` | R provider | Claude: UUIDv5 of the run ID, set when the row is inserted, before launch. Codex: thread ID from `thread/start`, recorded before the first `turn/start`. |
| `codexGeneration` | R Codex | App-server connection generation; scopes request IDs. |
| `herdr` | R Herdr | `{agentName, paneId}` for interactive runs. |
| `status`, `blockedOn` | D | From provider observations; §4. |
| `lastTurn` | C provider | `{id, outcome, error}`. Kept apart from `status`. |
| `pendingRequests` | C provider | Approvals and questions the provider is waiting on. |
| `lastActivityAt` | A | Last provider observation of any kind. Drives stall detection. |
| `retryAt` | A | Backoff: `min(10s·2^(n−1), cap)`. |
| `launchedAt`, `endedAt`, `endReason` | A | `submitted`, `superseded`, `canceled`, `crashed`, `failed`, `task_done`. |

### Worktree

| Field | Own | Notes |
|---|---|---|
| `path` | A | Primary key. Canonical realpath (`/private/var/…`, never `/var/…`). |
| `taskId`, `repoId`, `branch`, `baseBranch`, `baseSha` | A | `baseSha` is the base when the worktree was created. |
| `portSlot` | A | Null until ports land (Phase 5). |
| `herdrWorkspaceId` | R Herdr | |
| `createdAt`, `removedAt` | A | |
| `git` | C git | `{headSha, dirty, aheadOfBase, at}`. |

### Artifact

Metadata in SQLite; content as files in the data directory, mirrored to `<worktree>/.task/`.

| Field | Own | Notes |
|---|---|---|
| `id`, `taskId`, `kind` | A | `brief`, `plan`, `decisions`, `findings`, `test_results`, `handoff`. |
| `version` | A | Monotonic per (task, kind). `decisions` is append-only. |
| `path`, `sha256` | A | Relative to the data directory. |
| `createdBy`, `createdAt` | A | `human`, `coordinator` or a run. |

`findings.json` is a projection of the findings table, written for agents; the table is the source.
Plan content is the `Plan` type (goal, non-goals, steps, areas, acceptance criteria, test plan, risks,
open questions, suggested implementer).

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
| Message | `id, runId, purpose, text, textHash, status, attempts, transportRef, sentAt, delivered` | Status `pending → sent → delivered` (or `failed`). §5.4. |
| Question | `id, taskId, runId, question, options, blocking, askedAt, answer, answeredAt` | From `ask_human`. |
| Repo | `id, root, github, baseBranch, defaultProviders, serialTests` | |

### IDs

Reconcile is pure, so it can't draw random IDs. IDs it creates are derived from stable keys: run IDs
from `(task, role, round, attempt)`, Claude session IDs as UUIDv5 of the run ID, message IDs from
`(run, purpose, sequence)`, action keys from the intent (§5.5). IDs that arrive with an input (finding
IDs, question IDs) are assigned by the I/O layer when the input is persisted.

## 2. Stage rules

| Stage | Who works | Notes |
|---|---|---|
| `backlog` | nobody | Parked. |
| `todo` | nobody | Queued for capacity and dependencies. |
| `planning` | planner (headless) | |
| `plan_approval` | nobody | Only when `requirePlanApproval`. |
| `in_progress` | implementer (interactive, in Herdr) | |
| `in_review` | reviewer (headless, editing disabled) | The implementer's session stays alive for fix rounds. |
| `awaiting_approval` | nobody | Human reviews the diff. |
| `merging` | nobody | Merge requested; waiting to see it on GitHub. |
| `done`, `canceled` | nobody | Terminal (`canceled` can be reopened). |

Triggers: **H** human command, **M** MCP tool call from the task's *current* run for that role, **R** a fact
found by reconcile. "Start X" means insert the run row (with its session ID for Claude), then `start_run`,
then the first `send_message` once the session ID is recorded.

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
| 10 | in_review | awaiting_approval | M `submit_review` | `reviewedSha` = round head = PR head; a verdict for every `addressed`/`disputed` finding; after applying it, 0 open blocking; PR not conflicting; CI not failing | Store findings and verdicts; `stop_run` reviewer; `notify` attention |
| 11 | in_review | in_progress | M `submit_review` | Same SHA and verdict guards; open blocking > 0; `reviewRound < reviewRoundCap`; converging | Store findings; `stop_run` reviewer; `send_message` fix round to the implementer (resume it if it ended) |
| 12 | in_review | in_review, flag | M `submit_review` | Open blocking > 0 and `reviewRound ≥ cap` → `blocked: review_round_cap`. A finding reopened, or open blocking ≥ last round's → `blocked: review_not_converging` | Store findings; `stop_run` reviewer; `notify` attention |
| 13 | in_review (blocked by #12) | in_progress | H `grant_review_round` | — | For `review_round_cap`, `reviewRoundCap += 1`; clear flag; `send_message` fix round |
| 14 | in_review (blocked by #12) | awaiting_approval | H `waive_finding` × n | 0 open blocking afterwards | Clear flag; `notify` |
| 15 | awaiting_approval | merging | H `approve(headSha)` | `headSha` = PR head = last reviewed head; 0 open blocking; CI `success`, `pending` or `none`; not conflicting | Insert merge Approval (head, findings snapshot, CI); `merge_pr(matchHeadSha, auto = CI pending)` |
| 16 | awaiting_approval, merging | in_review | R new commit: PR head ≠ last reviewed head | — | Void approval (`new_commit`); `disable_auto_merge` if enabled; `map_findings` to the new head; `reviewRound += 1`; start reviewer |
| 17 | awaiting_approval, merging | in_progress | R CI `failure` on the head | — | One blocking `ci` finding per failed check (deduped by check-run ID); void approval (`ci_failed`); `disable_auto_merge` if enabled; `send_message` fix round |
| 18 | awaiting_approval | in_progress | H `request_changes(findings)` | At least one finding | Store them as blocking `human` findings; `send_message` fix round. Doesn't count against the cap. |
| 19 | merging | awaiting_approval | R `merge_pr` failed with `precondition` (head moved, not mergeable) | — | Void approval; `notify`. If the head moved, #16 applies instead. |
| 20 | any but done | done | R PR `merged` | — | Void open approvals; end all runs (`task_done`): `stop_run` headless runs, leave interactive panes to the human; `notify` |
| 21 | any but done, canceled | canceled | H `cancel` | — | `interrupt_run` working runs, `stop_run` headless runs, end runs (`canceled`); void approvals; `disable_auto_merge` if enabled. The PR and branch stay as they are. |
| 22 | canceled | backlog | H `reopen` | PR not merged | Runs stay ended; the next start is a new attempt. |
| 23 | planning … awaiting_approval | backlog | H `move backlog` | — | `interrupt_run` working runs; `stop_run` headless runs; void approvals (`stage_left`). Plan and findings are kept. |

Notes on the rules:

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
| `blocked: trust_dialog` | Interactive Claude start reports not ready, or Herdr `blocked` before any SessionStart | SessionStart arrives and the session is busy or idle |
| `failed: retries_exhausted` | A run failed `maxAttempts` (3) times | Human `retry` (new attempt, count starts again) |
| `failed: non_retryable_error` | Provider error with no retry (for example, Codex `willRetry: false` with an unsupported model) | Human `retry` |
| `failed: action_failed` | An action returned `fatal` | Human `retry` |

Retries within the limit are not flags: a failed or crashed run gets `retryAt` and a `schedule` action,
and the next attempt resumes the stored session ID when the provider still has it.

**Attention** is derived on every reconcile. A task needs the human while any of these reasons holds:

| Reason | Condition |
|---|---|
| `plan_needs_approval` | Stage `plan_approval` |
| `needs_approval` | Stage `awaiting_approval` |
| `question` | An unanswered `ask_human` question (blocking or not) |
| `provider_permission` / `provider_input` / `provider_dialog` | A live run's `blockedOn` is `permission` / `input` / `dialog` |
| `blocked` | `blocked` is set, except for `dependencies` and `provider_cooling_down`, which just wait |
| `failed` | `failed` is set |
| `stalled` | A run is `working` with no provider activity for `stallAfterMs`. Nothing is killed. |
| `status_unknown` | A run has been `unknown` for longer than `unknownGraceMs` |
| `over_budget` | Time in stages `planning` through `awaiting_approval` exceeds `budgetMinutes` |

## 4. Run status

Status comes from the provider's own channel. The terminal is never parsed. Herdr's screen-derived state
is used only when the provider reading is unavailable, and a status derived from Herdr never triggers a
stage transition. `status` and `lastTurn.outcome` are separate: an idle thread can have a failed last turn.

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
| absent (after being present) | no SessionEnd | `failed` (crash) | Retry: `claude --resume <id> --settings …`. |
| absent (never present) | — | `starting` | If Herdr shows `blocked` before SessionStart: `trust_dialog`. |
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
}
```

It is pure: no clock (`observations.now`), no randomness (§1 "IDs"), no I/O.

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
6. The executor runs pending outbox actions. Each result is persisted as an `action_result` input,
   which enqueues step 1.

### 5.2 Observations

| Observation | Owner and read | Used for |
|---|---|---|
| `git: Reading<GitWorktreeObservation>` | git: HEAD, branch, dirty, ahead/behind, `merge-tree` conflicts, remote head | Guards #9, #10, #15; new-commit detection |
| `github: Reading<PullRequestObservation \| null>` | GitHub, conditional GET with ETag | PR head, state, mergeability, CI, reviews and human comments |
| `runs[].provider` | Codex thread snapshot or Claude session (agents entry + hooks + headless exit) | §4 status, pending requests, delivery confirmation |
| `runs[].herdr` | Herdr agent (interactive runs) | Fallback status, trust dialog, pane presence |
| `externalSessions` | `claude agents --json`, Codex thread list, both joined on realpath `cwd` | Recorded as `origin: external` runs |
| `capacity` | Coordinator (across tasks) | Global and per-provider caps, cooling-down providers; `version` for CAS |
| `dependencies` | Coordinator (other tasks) | `blockedBy` |
| `inputs: Input[]` | Coordinator inbox | Human commands, validated MCP calls, action results |

`Reading.ok: false` means the owner couldn't be read. Reconcile treats that fact as unknown: no
transition whose guard needs it, and runs whose provider can't be read become `unknown`.

### 5.3 Actions and how results come back

Every action result comes back the same way: the executor writes an `action_result` input keyed by the
action key, and the next pass consumes it. Reconcile never assumes an action worked just because it
asked for it.

| Action | Executor | Success output → what the next pass does |
|---|---|---|
| `create_worktree` | git | `{path, headSha, baseSha}` → Worktree row; `task.worktreePath` |
| `write_task_files` | git | — |
| `open_workspace` | Herdr | `{workspaceId}` → `worktree.herdrWorkspaceId` |
| `start_run` | by provider and mode (below) | `{sessionId, codexGeneration, herdr}` → run row. For Codex, this is what unlocks the first `send_message` (principle 7). |
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
| start | `thread/start` (read-only sandbox for reviewers) | `thread/start`, then a Herdr pane running `codex resume <thread> --remote unix://…` | Agent SDK with Loom's session ID | Herdr pane: `claude --session-id <id> --settings <per-run>` |
| send | `turn/start`, or `turn/steer` with `expectedTurnId` | the same, through the app-server, not the pane | SDK | `herdr agent prompt` |
| interrupt | `turn/interrupt` | `turn/interrupt` | SDK interrupt | `herdr agent send-keys esc` |
| resume | `thread/resume` | `thread/resume`, then reattach the pane | SDK resume | Herdr pane: `claude --resume <id> --settings <per-run>` |

### 5.4 Idempotency and compare-and-set

1. **Deterministic.** The same state and observations give the same result.
2. **Fixed point.** Running reconcile again on `next` with the same owner readings (and the inputs now
   consumed) produces no transitions, and only actions whose keys are already in the outbox.
3. **Action keys name the intent**: `start_run:<runId>`, `send_message:<messageId>`,
   `push_branch:<taskId>:<sha>`, `open_pr:<taskId>:<branch>`, `merge_pr:<approvalId>`,
   `map_findings:<taskId>:<headSha>`, `schedule:<taskId>:<why>:<at>`. The outbox's key is unique, so
   emitting the same intent twice is a no-op.
4. **Actions run at least once.** After a crash, pending outbox rows run again. So every executor checks
   the owner before acting: an existing worktree on the branch, an existing PR for the branch, a session
   already live under that ID, a remote head already equal to the SHA. Merges are safe through
   `--match-head-commit`.
5. **Inputs are consumed exactly once**, in the same transaction as the compare-and-set. A pass that
   loses the race consumes nothing.
6. **Stage CAS**: `UPDATE tasks SET …, version = version + 1 WHERE id = ? AND version = ?`.
7. **Capacity CAS.** A global `capacity_version` is bumped whenever a run starts or ends. A commit that
   emits `start_run` also requires it unchanged, so two tasks can't take the last slot.
8. **Caches never decide.** Guards use this pass's readings. Cached fields (C) are for the UI and for
   diffing (for example, "the head changed since the last pass").
9. **Crashes don't prove a command didn't run** (spike 01). Before a new attempt after a crash or
   interrupt, re-read the worktree and include what's there in the attempt's first message.

### 5.5 When a message counts as delivered

Never on Herdr's `ok`, and never on a transport response alone.

| Path | `sent` when | `delivered` when |
|---|---|---|
| Codex `turn/start` | the response returns a turn ID | `turn/started` for that turn, or a snapshot containing it (resume doesn't replay `turn/started`) |
| Codex `turn/steer` | the response returns the expected turn ID | a user-message item with the message's text hash appears in that turn. **Provisional**: seen in spike 01, not a documented guarantee. |
| Claude (interactive or headless) | `herdr agent prompt` returns `ok`, or the SDK accepts it | `UserPromptSubmit` for the session whose normalized `prompt` hash matches (tabs → 4 spaces, CRLF → LF) |

Several prompts can join one Claude turn and share a `prompt_id`; each is still matched by its own
`UserPromptSubmit`. If a message is still not delivered after `deliveryTimeoutMs`: when the provider is
idle and shows no new turn, resend once under the same message ID; otherwise add attention. Herdr
`blocked` means a dialog is up (`provider_dialog`). Loom never generates text that starts with `/` or `!`,
and the Herdr adapter refuses it anyway (`refused` → the message fails and the human is notified).

## 6. Adapter interfaces

The TypeScript is in [`adapters.ts`](../../packages/core/src/adapters.ts). It has only the methods
that the observations in §5.2 and the actions in §5.3 need. Shared rules: every adapter validates external
output with zod before returning a core type; `subscribe` delivers hints (`{source, worktreePath,
sessionId}`) that only enqueue passes; nothing parses terminal output.

| Adapter | Reads (observations) | Writes (actions) |
|---|---|---|
| `GitAdapter` | `realpath`, `readWorktree`, `changedFiles` (NUL-delimited metadata, renames, hunks), `readBlob` | `createWorktree`, `push` (refuses any head except the expected one; never forces), `writeTaskFiles` (and `.git/info/exclude`) |
| `GitHubAdapter` | `findPullRequest` (conditional, ETag) | `openPullRequest` (idempotent), `mergePullRequest` (squash, `--match-head-commit`, optional `--auto`), `disableAutoMerge` |
| `HerdrAdapter` | `getAgent`, `listAgents`, `subscribe` | `openWorkspace`, `startAgent` (scrubbed environment), `prompt` (refuses `/` and `!`), `interrupt` (Esc) |
| `CodexAdapter` | `readThread`, `resumeThread`, `readRateLimits`, `generation`, `subscribe` | `startThread`, `startTurn`, `steerTurn`, `interruptTurn`, `answerRequest` (rejects a stale generation), `unsubscribe`, `attachArgs` |
| `ClaudeAdapter` | `listSessions` (`claude agents --json`), `hookSummary`, `headlessState`, `subscribe` | `interactiveArgs`, `startHeadless`, `sendHeadless`, `interruptHeadless` |

Deliberately missing: attach and takeover for the embedded terminal (`apps/desktop` owns them; spike 03),
Codex `review/start`, and anything that reads a pane's screen.

## 7. Loom MCP tools

Types: [`mcp.ts`](../../packages/core/src/mcp.ts). `packages/mcp` will hold the zod schemas, with a
type-level test that they equal these types.

**Identity.** Each run gets its own MCP endpoint token in its per-run config (`--settings` for Claude,
`-c` for Codex). The token maps to the run, and through the run to the task, so no tool takes a task or
run ID, and an agent can't act on another task.

**Flow.** Validate the input against the schema → resolve the token to a run → persist it as an `mcp`
input (assigning finding and question IDs, and building each finding's full anchor from the reviewed
blobs) → run a reconcile pass for the task → answer with that input's disposition. `get_task_context` is
read-only and never becomes an input.

| Tool | Role and stage | Input | Output | Guards (else `guard_failed`) |
|---|---|---|---|---|
| `get_task_context` | any run | `{}` | task, role, run, worktree, brief, plan, decisions, handoff, role-filtered findings, test results, answered questions, WORKFLOW commands | — |
| `submit_plan` | planner / `planning` | `{plan: Plan}` | `{planVersion, next}` | Plan has a goal, at least one step and one acceptance criterion |
| `report_progress` | any current run | `{summary, stepIndex, decisions[], testResults[]}` | `{recorded}` | `stepIndex` within the plan |
| `ask_human` | any current run | `{question, options[], blocking}` | `{questionId, delivery: "message"}` | — |
| `submit_for_review` | implementer / `in_progress` | `{headSha, summary, testResults[], handoff}` | `{round}` | `headSha` = HEAD; clean tree; ahead of base; every finding `addressed` in this round names a commit |
| `submit_review` | reviewer / `in_review` | `{reviewedSha, summary, findings[], verdicts[], testResults[]}` | `{round, openBlocking, next}` | `reviewedSha` = round head; locations exist in that commit; a verdict for every `addressed`/`disputed` finding |
| `resolve_finding` | implementer / `in_progress` | `{findingId, resolution: fixed \| disputed, note, commitSha}` | `{status}` | Finding is `open` and belongs to the task; `fixed` needs a commit reachable from HEAD |

Errors: `invalid_input`, `unknown_run`, `stale_run` (the run was superseded or ended), `wrong_stage`,
`guard_failed`. Each has `details`: one line per failed check, written for the agent to act on.
`ask_human` answers arrive later as a user message quoting the question ID, and in `get_task_context`.

## 8. Storage

SQLite in WAL mode (better-sqlite3), one database per instance data directory (`LOOM_INSTANCE`).
Artifact content lives beside it at `tasks/<taskId>/<kind>/v<N>.<ext>`. JSON columns are validated with
zod when read. Times are ISO-8601 text.

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
CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id),
  blocked_by TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY (task_id, blocked_by));
CREATE TABLE worktrees (path TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  repo_id TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL, base_sha TEXT NOT NULL,
  port_slot INTEGER UNIQUE, herdr_workspace_id TEXT, git_cache TEXT,
  created_at TEXT NOT NULL, removed_at TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL, provider TEXT NOT NULL, mode TEXT NOT NULL, origin TEXT NOT NULL,
  worktree_path TEXT NOT NULL, round INTEGER NOT NULL, attempt INTEGER NOT NULL, model TEXT NOT NULL,
  session_id TEXT, codex_generation INTEGER, herdr TEXT,
  status TEXT NOT NULL, blocked_on TEXT, last_turn TEXT, pending_requests TEXT NOT NULL,
  last_activity_at TEXT, retry_at TEXT, launched_at TEXT, ended_at TEXT, end_reason TEXT,
  UNIQUE (provider, session_id));
CREATE INDEX runs_live ON runs(task_id) WHERE ended_at IS NULL;
CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), purpose TEXT NOT NULL,
  text TEXT NOT NULL, text_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
  transport_ref TEXT, sent_at TEXT, delivered TEXT);
CREATE TABLE questions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL, blocking INTEGER NOT NULL, asked_at TEXT NOT NULL, answer TEXT, answered_at TEXT);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
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
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, result_input_id TEXT);
CREATE TABLE claude_hooks (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  event TEXT NOT NULL, prompt_id TEXT, received_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE github_cache (repo_id TEXT NOT NULL, branch TEXT NOT NULL, etag TEXT,
  pr TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (repo_id, branch));
```

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

`packages/fake-agent` implements the provider side of `CodexAdapter`, `ClaudeAdapter` and `HerdrAdapter`
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

## 10. Provisional until spike 05

These parts follow the architecture's restart table but aren't verified:

| Area | Current assumption |
|---|---|
| Coordinator restart | Load SQLite; run `pending`/`running` outbox rows again; `thread/resume` every live Codex run; poll `claude agents`; reconcile every task that isn't terminal. |
| Codex app-server restart | Generation + 1; requests from older generations are dropped, never answered. Runs are `unknown` until `thread/resume`. A turn that shows as `interrupted` after the crash counts as a failed attempt. |
| Herdr server restart | Interactive runs go `unknown`. Claude runs are still found through `claude agents`, Codex runs through the app-server. Whether panes survive, and what to restart, is open. |
| Resume attempts | "N attempts" is `retry.maxAttempts` (3) for now. |
| Thresholds | `unknownGraceMs` 60 s, `deliveryTimeoutMs` 10 s, `stallAfterMs` 15 min: placeholders. |
| Hook spooling | Whether Claude hooks should go to a spool file while the coordinator is down. |

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

## 12. Decisions for review

| # | Decision | Why |
|---|---|---|
| 1 | Plan approval is its own stage, `plan_approval`. | "Waiting on the human" gets its own CAS, audit row and attention reason. The board can still show it under Planning. |
| 2 | Exhausted retries set `failed`, not `blocked` (`architecture.md` updated in this PR). | `blocked` means waiting on something outside Loom; `failed` means Loom's automatic path gave up. The human acts differently on each. |
| 3 | `reviewRound` counts reviewer runs. The cap limits going back to `in_progress`; a re-review after a new commit always runs; `request_changes` isn't capped. | Nothing merges unreviewed, and the human stays in charge of their own requests. |
| 4 | `blocker` and `major` findings block. GitHub comments block only under a `changes_requested` review. A failed CI check becomes a blocking `ci` finding. | Agents choose severity and code chooses what it means (architecture: code decides guards). |
| 5 | CI failing after approval goes to `in_progress`; a new commit goes to `in_review`. | A CI failure needs a fix; a new commit needs a review. |
| 6 | A voided approval disarms auto-merge first (`disable_auto_merge`). | `--auto` could otherwise merge a head the human never approved. |
| 7 | `merge_pr` succeeding never moves a task; only an observed merge does. | Done is derived from GitHub. |
| 8 | Cancel leaves the PR and branch alone. | GitHub owns them. The human closes the PR if they want it closed. |
| 9 | The git adapter creates worktrees; Herdr only opens a workspace on the path. | Git owns branches, and headless runs shouldn't need Herdr. |
| 10 | IDs are derived (Claude session = UUIDv5 of the run ID). | Keeps reconcile pure. The same run always gets the same session, so `start_run` is naturally idempotent. |
| 11 | `ReconcileResult` also returns `transitions` and `inputs`. | The audit log and MCP replies must commit atomically with the state. |
| 12 | Inbox and outbox tables. | Inputs are consumed exactly once; actions run at least once and survive a crash. |
| 13 | Capacity is compare-and-set on a global version. | Reconcile is per task, but caps are global. |
| 14 | MCP identity comes from a per-run token; tools take no IDs. | An agent can't act on another task, or as a superseded run. |
| 15 | `ask_human` returns immediately; the answer comes as a message. | No tool call held open for hours; it works the same for both providers. |
| 16 | Codex steer counts as delivered on the user-message item (provisional). | `turn/steer` joins an existing turn, so there's no `turn/started`. |
| 17 | Status derived from Herdr never triggers a stage transition. | Principle 4: Herdr reads the screen. |
| 18 | Claude hooks are kept as a receipt log. | They can't be re-read; `claude agents` still owns status. |
| 19 | `packages/core` has no runtime dependencies and compiles with `types: []`. Zod schemas live in `packages/mcp` and `packages/protocol`, tested equal to the core types. | Node APIs can't be imported into core by accident, and core stays exhaustively testable. |
| 20 | Flags stop automatic starts and retries, not submissions or human commands. | A submission is still valid work; the human always has control. |
