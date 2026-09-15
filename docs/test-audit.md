# Test audit — 2026-09-15

## Scope and decisions

Searched the suite for literal prose, snapshots, mock call counts/order, source reads, retry
identifiers, and legacy/workaround cases. Read the flagged assertions with their implementation,
with particular attention to coordinator prompts, conversations, lifecycle/recovery, settings,
protocol and PR integration, and desktop sidebar, terminal and Main tests. This was a targeted
contract audit, not a claim that every assertion in the suite needs replacing.

| Area | Decision |
| --- | --- |
| Prompt templates | Check repository/task identity, lossless note/description insertion and role tool names. Remove sentence matching, introduction punctuation/counting and historical wording exclusions. Instruction prose still needs human review; matching a sentence does not demonstrate agent behavior. |
| Settings validation | Start from valid defaults and invalidate one relationship per case. Require a diagnostic without copying its sentence. This preserves independent rejection coverage. |
| Retry/reopen lifecycle | Require a new action identity and executable pending work, retain the same message/session where required, and keep delivery pending. Remove the exact `#2` suffix and generated run-ID spelling from assertions. |
| Conversation subscriptions | Observe cleared rows after unsubscribe and fresh content on return. Remove synchronization through a log-call count and a second unresolved fake read. Preserve append-only publication and coalesced-read coverage. |
| Sidebar | Check accessible controls, selection, status, grouping and filtering. Remove the snapshot, DOM sibling/footer checks, concatenated text and exact spinner glyph set. |
| Terminal late attach | Model attached clients and assert only the surviving panel remains attached. Remove the requirement to call kill exactly twice. Keep client identity/remount and sizing checks: those protect visible terminal continuity. |
| Agent settings | Match each returned thread to its run and check role permissions, instead of assuming a five-call sandbox sequence. Keep provider arguments: model, reasoning effort and read-only access are observable at that boundary. |
| E2E cleanup | Check actual per-task server ownership over fake providers in the existing Todo-to-Done test. Remove the duplicate full workflow whose only assertion was a stop-method spy, and a headless cleanup loop that never executed under the interactive fixture. |

Kept the detail-page spinner regression, Main keyboard/focus behavior, permission gating,
provider receipt identity, retry budgets, migration compatibility, Git safety/ancestry tests,
and subscriber deduplication. These protect current behavior even when implemented with spies.
No product bug was exposed by the rewritten assertions; no product behavior was changed.

## Timeout cause and changes

The suite previously used Vitest's CPU-sized worker pool even though integration workers also
spawn many Git subprocesses. Concurrent suites on the shared machine compound that contention.
The scenario driver also requested a complete worktree observation merely to substitute `$HEAD`
into a tool input: status, merge-tree, ancestry and several ref reads were discarded on every
call. The coordinator independently performs the complete observation to validate that call.

Bound test execution to two workers, and read only `git rev-parse HEAD` for scenario substitution.
Keep real repositories, remotes, MCP/WS transport, coordinator and store in integration tests;
agents remain fake. Remove the duplicate workflow replay. Restore the shared test/hook limit to
30 seconds and remove the e2e-specific 60-second exceptions. No retry or extended timeout was added.

## Validation

- Unchanged branch: the four reported timeout-prone files passed, 53 tests in 92.93 seconds.
- Updated tests: those four files plus prompts, conversations, sidebar, terminal and core
  lifecycle/regressions passed, 122 tests in 51.32 seconds. The longest individual test took
  10.38 seconds, leaving substantial room under the 30-second limit.
- Isolated settings and final core lifecycle/regression changes: 64 tests passed in 0.60 seconds.
- Final e2e run: all nine cases passed under 30 seconds. The accompanying agent-settings
  rewrite initially failed because it joined against the compact snapshot, which omits older
  ended runs. After using full stored run history, all four agent-settings cases passed in
  18.06 seconds.

These are observations on a shared machine, not a controlled performance benchmark. The sets
also differ because one duplicate e2e was removed and audit tests were included in the second run.
Full-suite, lint and typecheck results are owned by CI. Real-provider tests remain opt-in.
