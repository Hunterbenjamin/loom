# Phase 1b: implement `packages/core`

**Agent:** codex · **Branch:** `feat/core-impl` · **Timebox:** about 3 hours, counted from your first
commit. Time spent waiting for a human's approval doesn't count.

## Why

[`docs/design/core.md`](../design/core.md) was reviewed and merged in Phase 1a, and `packages/core`
currently holds its types with no logic. This phase makes the reconciler real. Everything later depends
on it: Phase 2's adapters are written against these contracts, and the walking skeleton runs this code.

## Scope

**In scope:** `packages/core` only. The pure reconciler and the stage rules, plus their tests.

**Out of scope, for later phases:** `packages/store`, `packages/mcp`, `packages/fake-agent`, the
adapters, the executor, and the coordinator. Don't create those packages here.

## What to build

Implement `Reconcile` exactly as `docs/design/core.md` specifies:

- **§2 stage rules:** all 23 transitions, with their triggers, guards and actions.
- **§3 flags and attention:** every flag, and attention derived on each pass.
- **§4 run status:** the Codex and Claude mapping tables, including that a reading which isn't `ok`
  makes a run `unknown` and blocks any guard that needs it.
- **§5 the contract:** consuming inputs exactly once, emitting actions with the documented keys,
  returning `transitions` and `inputs`, and §5.5's delivery rules.
- **§1 IDs:** derived as documented.

Keep it pure: no clock (use `observations.now`), no randomness, no I/O, and no new runtime
dependencies (decision 19).

**One thing the design leaves open.** Deriving a Claude session ID needs a UUIDv5, which needs hashing,
which core can't do without a dependency or Node APIs. Resolve it by taking the derivation as an
injected pure function (for example on `ReconcileConfig`), implemented later by the caller. Keep core
dependency-free, and write down what you chose.

## Tests

Vitest, beside the code. They are the deliverable as much as the logic is:

- One test per transition row, covering both the guard passing and each guard failing.
- Flags, attention reasons, and both status mapping tables.
- Delivery: `sent` versus `delivered`, and that Herdr's `ok` alone never counts (§5.5).
- **Fixed point:** for a set of states, running reconcile again on its own output with the same
  observations produces no transitions, and no actions whose keys aren't already in the outbox.
- **Determinism:** the same inputs always give the same result.
- Inputs consumed exactly once, and rejected inputs returning the documented `McpError` codes.

Build whatever small fixture helpers you need inside the package. Don't start a real agent.

## Rules

- Follow `AGENTS.md`.
- The design doc is the contract. If you find something wrong, underspecified or impossible, do not
  silently change the behavior: implement the closest correct thing, and list every deviation in the PR
  description under "Deviations from the design", one line each, with why.
- Keep modules small and split by area, for example stages, flags, attention, status, delivery and IDs.
- Run `pnpm test`, `pnpm lint` and `pnpm typecheck` before opening the PR.
- Open a PR titled "Phase 1b: core reconciler" and stop. Don't merge.
