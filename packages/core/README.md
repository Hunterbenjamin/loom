# @loom/core

Pure `reconcile(state, observations)` returns next state, outbox actions, audit transitions and
input dispositions. No I/O, clock reads or runtime dependencies. The caller injects time, fresh
owner observations, configuration and stable hash/session-ID functions.

[Core workflow](../../docs/design/core.md) owns behavior and invariants;
[store](../store/README.md) owns transaction, receipt and artifact persistence requirements.
External boundaries validate input with zod; core checks semantic guards.

## Source map

| Module | Responsibility |
|---|---|
| [reconcile.ts](src/reconcile.ts), [entities.ts](src/entities.ts) | State/result/config and domain types |
| [engine.ts](src/engine.ts) | Reconcile ordering and input consumption |
| [stages.ts](src/stages.ts), [human.ts](src/human.ts), [submissions.ts](src/submissions.ts) | Stage and submission guards |
| [ci-gate.ts](src/ci-gate.ts), [review-publication.ts](src/review-publication.ts) | CI-before-review and publication |
| [base-sync.ts](src/base-sync.ts) | Fetched-base changes and conflicts |
| [status.ts](src/status.ts), [lifecycle.ts](src/lifecycle.ts), [flags.ts](src/flags.ts) | Run status, retry and attention |
| [delivery.ts](src/delivery.ts), [results.ts](src/results.ts) | Native delivery evidence and action results |
| [context.ts](src/context.ts), [task-context.ts](src/task-context.ts) | Deterministic records and agent context |
| [automation.ts](src/automation.ts) | Permission allowlist and vanished-work rescue |
| [settings.ts](src/settings.ts), [keybindings.ts](src/keybindings.ts) | Settings catalog and key grammar/defaults |
| [work-time.ts](src/work-time.ts) | Transition-derived work interval |

Colocated tests use [test/fixtures.ts](test/fixtures.ts), injected hashes/IDs and owner readings.
They cover guards, determinism, fixed points, replay, capacity, cancellation and multi-pass delivery.
No provider processes run. Run only relevant test files locally according to the
[agent check policy](../../docs/design/agents.md#issue-agents).
