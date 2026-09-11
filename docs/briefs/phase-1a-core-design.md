# Phase 1a: core design

**Agent:** claude · **Branch:** `feat/core-design` · **Output:** a design PR. Implementation comes in 1b,
after this is approved.

## Why

Everything after this builds on the core: the stage rules, the reconciler, the storage layout and the
adapter interfaces. In Phase 2, parallel agents implement adapters against these contracts, so the
contracts must be explicit and reviewed before any logic lands.

## Read first

- `docs/architecture.md`, all of it.
- `spikes/01-codex-shared-thread/FINDINGS.md` (Codex status mapping and recovery),
  `spikes/03-embedded-terminal/FINDINGS.md` (attach rules),
  `spikes/04-pierre-diffs/FINDINGS.md` (finding anchors).
- `spikes/02-claude-hooks/FINDINGS.md` (Claude status, hooks and prompt delivery).
- Spike 05 (restarts) hasn't run yet. Mark anything that depends on it as provisional instead of
  guessing.

## Deliverable

### 1. `docs/design/core.md`

Prefer tables to prose, and keep it under about 600 lines.

- **Entities.** Task, Run (role, provider, session or thread ID, pane, status), Worktree, Artifact
  (brief, plan, findings, test results, handoff), Finding (with spike 04's anchor), Approval (bound
  to head SHA, findings snapshot and CI state), Transition (audit log). For each one, give its fields
  and say which are authoritative in Loom and which are references to another owner.
- **Stage rules.** One table row per transition: from, to, trigger (human, MCP tool call, or a fact
  found by reconcile), guard, and actions. Cover:
  - the optional plan-approval gate;
  - the review-round cap;
  - blocked and failed flags;
  - cancel;
  - an approval voided by a new commit;
  - Done only when the PR's merge is observed.
- **Run status and attention.** How both are derived from provider observations. Use spike 01's
  mapping for Codex and spike 02's for Claude.
- **Reconciler contract.** `reconcile(taskId)` as a pure function:
  `(TaskState, Observations) → { next: TaskState, actions: Action[] }`.
  - List the observation types and the action types (start run, send message, interrupt, create
    worktree, open PR, merge, notify, …).
  - Explain how an action's result comes back as a later observation.
  - Give the idempotency and compare-and-set rules.
  - Say what a message counts as "delivered" on: never Herdr's "ok"; only the provider's own
    confirmation (Codex `turn/started`, Claude's `UserPromptSubmit` hook).
- **Adapter interfaces** (TypeScript) for Codex, Claude, Herdr, GitHub and Git. Include only the
  methods the reconciler's actions and observations need.
- **Loom MCP tools.** Input and output schemas for `get_task_context`, `submit_plan`, `report_progress`,
  `ask_human`, `submit_for_review`, `submit_review` and `resolve_finding`.
- **Storage.** A SQLite schema sketch and the migration policy: only add; remove in a later release.
- **fake-agent.** The scenario format that tests use to script a provider.
- **Out of v1.** What's deliberately left out.
- **Decisions for review.** Wherever the architecture is ambiguous, pick an option, say why, and list it
  here.

### 2. `packages/core`, types only

- The entity, observation, action and adapter types as TypeScript. No logic yet.
- Add it to the workspace with a `typecheck` script, so `pnpm typecheck` checks it.
- This lets reviewers read the contracts as code.

## Rules

- Follow `AGENTS.md`.
- Write no implementation logic. The only tests allowed are ones that prove the types compile.
- Run `pnpm test`, `pnpm lint` and `pnpm typecheck`.
- Open a PR titled "Phase 1a: core design", then stop. Don't start implementing.
