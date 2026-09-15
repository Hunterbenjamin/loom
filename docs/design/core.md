# Core workflow

`reconcile(state, observations)` is pure: the same inputs produce the same next state, actions,
transitions and input dispositions. It performs no I/O and reads no clock. Types are defined in
[core/src](../../packages/core/src); this document explains the rules rather than copying those types.
[Architecture](../architecture.md) owns integration boundaries; [agent layers](agents.md) owns role duties.

## Contract map

| Definition | Source |
|---|---|
| Entities and IDs | [entities.ts](../../packages/core/src/entities.ts), [ids.ts](../../packages/core/src/ids.ts) |
| State, result and injected config | [reconcile.ts](../../packages/core/src/reconcile.ts) |
| Owner readings and human commands | [observations.ts](../../packages/core/src/observations.ts) |
| Outbox intents/results | [actions.ts](../../packages/core/src/actions.ts), [results.ts](../../packages/core/src/results.ts) |
| MCP input/output types | [mcp.ts](../../packages/core/src/mcp.ts) |
| Pass ordering | [engine.ts](../../packages/core/src/engine.ts) |

Task stage, run status and attention stay separate. `blocked` means waiting on an outside decision
or condition; `failed` means the automatic path exhausted its options. Flags stop automatic work,
not valid submissions or human commands. Terminal tasks suppress attention while retaining history.

## Stage rules

[stages.ts](../../packages/core/src/stages.ts), [human.ts](../../packages/core/src/human.ts) and
[submissions.ts](../../packages/core/src/submissions.ts) implement the guarded transitions.

| Stage | Exit |
|---|---|
| Backlog | Human queues Todo; version-checked edits can change title, description, size and plan-approval policy |
| Todo | Dependencies must be Done, capacity available and provider ready; start planning or accepted implementation |
| Planning | Valid plan goes to Plan approval when required, otherwise In progress |
| Plan approval | Approve the current plan version, or reject with feedback for the planner |
| In progress | Clean committed submission ahead of base goes to CI |
| CI | Matching successful checks start review; failure starts implementation fixes; changed HEAD withdraws submission |
| In review | Explicit blocking escalation starts fixes; clear review waits for publication, then Awaiting approval |
| Awaiting approval | Approval names the reviewed head and passes merge guards |
| Merging | Wait for GitHub to report the PR merged |
| Done | GitHub has reported the workflow PR merged |
| Canceled | Work stops; branch and PR remain; the human can reopen |

Small tasks generate an accepted plan from their title/description and skip planning, unless they
require plan approval: then they plan and wait for approval like any other task. This is a
routing choice, not a promise of completion within a fixed duration. Capacity and dependency guards
still apply. Accepted plans survive parking in Backlog.

### CI gate

`submit_for_review` checks the current worktree branch and HEAD, a clean tree (including non-ignored
untracked files), and commits ahead of base. It saves a handoff and `ciGate`, then publishes that
immutable head. [ci-gate.ts](../../packages/core/src/ci-gate.ts) reads checks/statuses by commit SHA,
so a PR is not required. No reported checks count as no CI after five minutes from a successful push.

Failure creates blocking CI evidence and starts a fresh fix round. Later passing CI resolves earlier
CI findings. A changed worktree HEAD withdraws the old submission; the implementer must submit the
new commit. An idle implementer owes no work while waiting in CI.

### Review and merge

Review counts use monotonic run rounds. Explicit escalation is subject to the review cap and
convergence checks; human requests for changes retain their own path. Findings reopened or no longer
decreasing can require a human decision. The [agent contract](agents.md#issue-agents) defines which
review findings block and which verdicts reviewers owe.

A clear submission remains In review while its reviewed head is pushed and its PR opened/refreshed.
Awaiting approval requires the published reviewed head, positive mergeability and non-failing CI
for that head. Old PR data during publication must not start a spurious review round.

A merge approval names the head, findings snapshot and CI state. The approved head must equal both
the PR head and last reviewed head, with no open blockers and positive mergeability. Human approval
can accept pending CI using GitHub auto-merge. New commits, failing CI or changed findings void
approval; enabled auto-merge is disarmed before superseding work. Merge success alone never means
Done: only an observed GitHub merge does.

Captured merge policy is `require-human`, `auto-small` or `auto-all`. Automatic policy creates an attributed
approval only for eligible size, clear findings, the published reviewed head, fresh successful/no-check
CI and an open mergeable PR. It uses the same guarded merge path.

Independent repository PR merges re-read the named head, reject drafts, unknown/conflicting
mergeability and pending/failed CI, and allow zero checks. They squash without auto-merge or override.
Issue-owned PRs, including explicit issue links, are refused on that direct path and require issue
approval. Close/delete commands re-read GitHub and do not change a local checkout.

**Existing safety conflict:** normal publication can call the Git adapter with an expected remote
head and use `--force-with-lease` on the issue branch. [AGENTS.md](../../AGENTS.md#safety) prohibits
force-pushes. This conflict is unresolved. Base-branch publication is refused. See [git/index.ts](../../packages/adapters/git/src/index.ts).

### Base changes

[base-sync.ts](../../packages/core/src/base-sync.ts) reads fetched-base Git evidence, preferring
local `merge-tree` conflict results to GitHub's asynchronously updated mergeability. Unknown
mergeability is not proof of a conflict.

Clean base movement is merged automatically only at the CI gate, before review, in a clean owned
checkout. The executor creates an exact two-parent merge, pushes without force and gates the new
SHA on CI. Clean movement during/after review does not invalidate an already reviewed head.
Actual conflicts retire the current reviewer and start a fresh implementer to merge base and resolve
conflicts. Replacement reviews caused by base movement do not consume the ordinary review cap.

## Reconciliation

### One pass

[coordinator/loop.ts](../../apps/coordinator/src/loop.ts) runs one pass per task at a time; different
tasks read owners concurrently. Hints, inputs and timers enqueue work; hints arriving during a pass
coalesce into another pass.

1. Load state and pending inputs in a read transaction (normally one input per pass).
2. Read owners outside the transaction; inject the current time, capacity and dependencies.
3. Reconcile, then commit with task-version and, when requested, capacity-version compare-and-set.
4. On a conflict reload and retry, up to three attempts, then re-enqueue.
5. Execute eligible outbox actions; persist each result as a new input.

Actions are serialized per task, with tasks executing concurrently. Git operations that write shared
repository refs are serialized per repository. Reconciliation against its own result and unchanged
readings reaches a fixed point; object key ordering alone is not a change.

### Instant human commands

`decidableFromLastReadings` selects edit, move, cancel, plan/merge approval and finding waiver.
The coordinator can accept these immediately against the readings of the last committed pass,
refreshed with local time, capacity and the command. A refusal waits for a fresh pass, because old
evidence may be the reason for rejection. Without previous readings, the normal pass decides.

The fast commit marks the task unverified: no action executes until a fresh owner-read pass commits
and rechecks the guards. Commands that send messages or answer agents always take the fresh path.
A human-command acknowledgement waits for its disposition; success means accepted, while external
side effects may still be pending.

### State and action durability

The caller validates external data and injects stable pure hashes/session-ID derivation. Failed
readings remain failed; missing data must not be converted into a clean tree, absent request or
ended session. Fresh evidence supplies dirty paths, reachable fixing commits and resumability.

[Store transactions](../../packages/store/README.md#atomic-commits-and-receipts) atomically persist
owned state, input dispositions, transitions, artifacts and outbox changes. Action keys identify
intents; dependencies enforce ordering. Actions run at least once, so the executor checks the owner
and current claim before side effects. Late receipts cannot resurrect canceled work. `precondition`
means re-read and decide, `retryable` uses bounded backoff, and `fatal` raises failure.

Capacity counts active/starting/blocked runs and pending reservations. Idle implementers release a
slot; new work reacquires it. Capacity compare-and-set prevents two tasks taking the last slot.
Deferred launch intentions remain durable until capacity, retirement and setup allow them to run.

## Status and message delivery

[status.ts](../../packages/core/src/status.ts) derives run state from providers;
[lifecycle.ts](../../packages/core/src/lifecycle.ts) handles resumability/retry, and
[flags.ts](../../packages/core/src/flags.ts) derives attention. A poll timestamp is not activity.
Unknown reads preserve uncertainty until native evidence resolves it; timeouts raise attention.
Recovery is described in [architecture](../architecture.md#recovery).

[delivery.ts](../../packages/core/src/delivery.ts) separates transport acceptance from native delivery:

| Path | Delivery evidence |
|---|---|
| Codex turn start | Native started turn or a snapshot containing that turn |
| Codex steer | Matching user message in the expected turn |
| Claude | Matching normalized prompt receipt for the session |

Launch results must commit provider identity before the first message; interactive delivery also
requires its pane. Sends are gated on fresh provider readiness, never into a pending permission or
question. A paste returning written is not delivery. Pending messages retain their timeout across
polls/restarts; an uncertain send raises attention rather than authorizing blind replay. Request
answers are tied to native occurrence/generation; resolved requests cancel obsolete actions.

## Findings, evidence and work time

Findings have an immutable original anchor and a current mapped location. Git hunks, renames and
blob evidence map anchors across heads; mapping is exact, moved, ambiguous or outdated. Missing
lines do not resolve findings, and ambiguous duplicates are never silently picked. The findings
table owns truth; its artifact is a projection.

Test reports record command, outcome, summary, run, timestamp and commit SHA. Nonempty progress
test reports require a fresh Git head. Reports accumulate as evidence rather than defining what
the implementation must do. Full shapes live in [entities.ts](../../packages/core/src/entities.ts).

[work-time.ts](../../packages/core/src/work-time.ts) derives work time from transitions: first entry
into In progress to the latest entry into Awaiting approval, or Done if merged without that stage.
Leaving the ready stages clears the end time until ready again. It excludes initial planning and
post-readiness approval waiting, but includes intervening CI/review/fix time. This elapsed span is
separate from `activeElapsedMs`, the active-stage budget counter.

## Coordinator automation

[automation.ts](../../packages/core/src/automation.ts) implements two narrow behaviors:

- Accept an implementer's native command approval when it exactly matches a validated repository
  workflow command or the conservative built-in `git add`, `git commit -m` and plain `pnpm install`
  forms. Claude requires a waiting Bash permission occurrence; Codex requires the current request
  generation. Questions and trust dialogs remain human input.
- Push clean committed work from a vanished interactive implementer when no submission, review,
  replacement or live run supersedes it and remote ancestry permits it. The executor rechecks the
  exact branch/head. This rescue retains attention and neither opens a PR nor invents a submission or stage change.
  It uses the shared publication path described under Review and merge.

[WORKFLOW parsing](../../apps/coordinator/README.md#workflowmd) supplies the command allowlist.
Failures do not cause an agent to file bugs or reset retry budgets automatically.
