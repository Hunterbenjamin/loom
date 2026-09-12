# Core reconciler

`reconcile(state, observations)` implements the Phase 1b contract in
[`docs/design/core.md`](../../docs/design/core.md). It returns the next owned state,
new outbox actions, audit transitions, and inbox dispositions. It never performs I/O,
reads a clock, starts a provider, or imports a runtime dependency.

Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` from the repository root.
Tests use in-memory fixtures in `test/fixtures.ts` and injected fake hashes/session IDs; no real agents run.
Shared test support is outside `src`; colocated `*.test.ts` files import it only for verification.

## Caller responsibilities

- Validate external inputs at the boundary (the future MCP/protocol/adapters own zod).
  Core checks semantic guards and returns actionable `McpError` details.
- Inject `deriveClaudeSessionId(runId, epoch)`: UUIDv5 of `${runId}#${epoch}` in a
  stable Loom namespace. Also inject pure SHA-256, used for normalized message
  text, artifact content, and sorted finding snapshots. Supply the worktree root,
  base branch and provider models. These functions are runtime configuration,
  not serialized SQLite data.
- Read owners freshly. `ok: false` never falls back to a cached fact for a guard.
  Herdr can explain a pre-session trust dialog; it never supplies a live provider
  status that advances a task.
- Commit state, input dispositions, transition rows and outbox changes atomically
  using the old task version. When `capacityVersion` is returned, CAS that global
  version too. Losing the transaction must consume no inputs and run no actions.
- Execute only pending outbox rows, after their `dependsOn` intents have succeeded.
  Re-check cancellation and the current intent before each external side effect.
  Actions already running at cancellation may finish; their late results cannot
  resurrect canceled work. Native idempotence checks remain the executor's job.
- Persist every returned action payload and its retry/dependency metadata. A retry
  replaces dependent references with the retry key. Keep needed intent receipts
  until no live state or dependent action refers to them. Archive inbox receipts
  only when those IDs can no longer be replayed; `consumedInputIds` makes replays
  within a loaded snapshot harmless, including rejected calls.
- Persist `artifactContents` with the artifact metadata in the same commit, then
  materialize those immutable versioned contents through `write_task_files`.
  Do not reload a metadata row without its content. `findings` remains the owner;
  its artifact is only a projection.

## Contract additions and interpretations

The types-only design omitted several facts needed by its own guards. The current
[design contract](../../docs/design/core.md) now incorporates these choices, including
required fields, their suppliers and initial/null semantics. PR #12 preserves the original
deviations list as history; no architecture ownership principle changes.

| Area | Phase 1b choice and reason |
| --- | --- |
| Pure hashing | Inject SHA-256 as well as the explicitly requested Claude UUIDv5 derivation; messages, artifacts and approval snapshots also require hashes. |
| Durable context | Persist plan content/version/acceptance, review head and last reviewed head, required verdict IDs and previous blocking count, artifact contents, latest progress, desired run, consumed input IDs and active budget elapsed time. Metadata alone cannot implement these guards or survive a deferred start. |
| Lifecycle evidence | Persist provider-seen and unknown-since timestamps, activity times, observed failure attempt and retry budget offset. An observation's fetch time is not activity. `resumable: false` must come from an authoritative provider check; absence alone cannot prove a Codex thread is gone. |
| Outbox | Add action payload, retry timing/lineage/budget, dependency keys and canceled status. Results otherwise cannot identify the affected run/message or retry the original intent, and independent at-least-once execution cannot enforce disarm/push/start ordering. A canceled generic intent gets a new suffixed key if requested again. |
| Capacity | Resolve design note 13.1 by counting starting/working/blocked runs, releasing idle implementers. Sending new work to an idle run reserves capacity again; queued fix messages wait when full. A terminating active planner can transfer its slot in the same CAS commit. |
| Git evidence | Add non-ignored `dirtyPaths` for actionable errors, and `reachableCommits` for fixed-finding validation. Ignored `.task/` and build output do not make a tree dirty. |
| Finding anchors | The boundary must verify blob existence/line bounds when constructing drafts. Core checks the supplied anchor's head, path, side, range and blob identity; it cannot read blobs itself. |
| CI identity | Require check-run `id` from the GitHub adapter. There is no name/head fallback; missing identity invalidates the reading. |
| Delivery | Persist transport path, baseline/expected turn IDs and attention state. A timeout resend keeps the message ID but uses `send_message:<id>#2` because the original outbox key has already succeeded. Transport failures separately use the bounded action retry policy. Messages to one run are serialized until provider delivery is known. |
| Uncertain delivery | Use existing `provider_input` attention plus a notification; the design has no delivery-specific attention reason. Ended runs retire their undelivered messages so old prompts cannot block a later resumed attempt. |
| Mergeability | Require positively observed `mergeable`, rather than accepting `unknown` as evidence of no conflict. New-head reconciliation takes precedence over old-head CI/precondition failures; observed merge takes precedence over every command. |
| Test evidence | Persist test command/outcome/summary with run, timestamp and head. A nonempty progress test report requires a fresh git HEAD when the call does not itself name one. |
| Artifact encoding | Use deterministic JSON content for pure artifact metadata; the executor materializes it. Every findings mutation updates the versioned projection, and decisions/test evidence accumulate. |
| Workspace sequencing | Missing worktrees are created before run construction; launch results unlock the first message. A desired role remains durable while capacity, flags or missing setup delay launch. |
| Attention | Terminal tasks suppress attention while retaining their historical questions/failures. Active elapsed budget time excludes backlog/todo/merging and terminal time. |

`WORKFLOW.md` reading/caching (design note 13.3) belongs to the future coordinator
and its `get_task_context` I/O boundary. That read-only MCP tool does not enter this
reconciler. Protocol, store, fake-agent and executor packages remain outside Phase 1b.

## Modules and verification

- `engine` sequences observation reconciliation and ordered input consumption.
- `stages`, `human`, `submissions` implement the 23 transition rows and semantic guards.
- `status`, `lifecycle`, `flags`, `delivery` keep issue stage, run state and attention separate.
- `results` applies executor results and schedules bounded retries.
- `context` creates deterministic owned records/actions; `helpers` contains pure ID,
  normalization, timestamp arithmetic and cloning functions.

Transition tests name every design row and exercise failed guards. Status tests cover
both provider tables. Delivery tests distinguish transport acceptance from native
confirmation. Structural comparisons ignore object key order and short-circuit without serializing whole
state; worst-case comparison remains linear. Most behavioral cases also assert determinism and a fixed point with
the same readings and replayed inputs; multi-pass tests cover launch, retry, cancellation,
capacity, provider generations, artifacts and outbox dependencies.
