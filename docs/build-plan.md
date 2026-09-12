# Build plan

## Phase 0: spikes (now, in parallel)

Spikes 01–04 run in parallel, one agent each, in their own Herdr worktrees. Spike 05 runs after 01 and 02
are merged, because it tests the recovery paths they establish. Each spike produces a `FINDINGS.md`. Where
the findings change the design, update `docs/architecture.md`.

## Phase 1: core (one human, one agent, one step at a time)

Build these:
- `packages/core`: stage rules and the reconciler, as pure logic;
- `packages/store`;
- the adapter interfaces;
- `packages/fake-agent`;
- a first draft of `packages/protocol`.

Keep this to one agent. Parallel agents working before these interfaces exist produce incompatible guesses.

It runs in two steps:
- **1a** is a design PR: `docs/design/core.md` plus the core types (brief:
  `docs/briefs/phase-1a-core-design.md`). Nothing is implemented until it's approved.
- **1b** implements the approved design.

## Phase 2: adapters (in parallel, 3–4 agents)

- One agent per adapter (codex, claude, herdr, github, git), plus `packages/mcp`.
- Each adapter lives in its own package and passes the shared contract tests against `fake-agent`.
- Checks against real providers are opt-in.
- The human keeps ownership of the core.

## Phase 3: walking skeleton, then self-hosting

The `apps/coordinator` CLI takes one task on this repo through the whole cycle: plan → implement → review → one fix round → approve → merge.

**Self-hosting milestone:**
- that cycle works end to end;
- a restart mid-run recovers;
- a PR merged on github.com shows up as Done.

**Built for remote access from the start, even though v1 runs on one machine:** the coordinator binds
to a configurable address (loopback by default) with token authentication, and `packages/protocol`
carries no localhost assumptions. This is a few lines now and a rewrite later. It's what allows a
phone inbox (Phase 5) and, eventually, moving the coordinator, Herdr and the worktrees to an
always-on machine while the laptop and phone stay clients.

From then on, all Loom work is filed as Loom tasks.

## Phase 4: the UI, built through Loom

Agents build the UI screens in parallel, working against the fixed protocol and recorded sample data. The screens are:
- sidebar, list, board;
- issue detail, with Activity, Plan, Agents, Terminal, Changes and Review tabs;
- command palette and shortcuts;
- diff review.

## Phase 5: polish

- ports and dev servers;
- overlap warnings and a rebase queue;
- GitHub issue import;
- notifications;
- routing around rate limits;
- a phone-friendly web build of the Needs-you inbox, approvals and review, served by the coordinator
  over a private network such as Tailscale. No terminals: away from the desk, nearly every action is a
  coordinator action.

## Guidance on parallel work

- Parallelize only across fixed interfaces and separate directories.
- Run at most 3–4 agents at a time. The limit is how much the human can review.
- Until the coordinator exists, the human is the coordinator. Don't build an orchestrator out of one agent
  that drives the others through Herdr.
- Cross-review: Codex reviews Claude's PRs, and Claude reviews Codex's. Write down every annoyance; that
  list becomes the first backlog.

## Rules for self-hosting

- **Two instances.**
  - *prod* is the installed build. It runs as a launchd agent with its own data directory, and manages this project.
  - *dev* is built from a worktree with `LOOM_INSTANCE=dev`. It has its own data directory, ports, Herdr session
    (`loom-dev`) and sandbox GitHub repo. Agents use it for end-to-end tests.
- **Merging to `main` doesn't change anything that's running.** `loom release` builds and installs a new version, then restarts prod.
  Keep the last few builds so you can roll back.
- **Migrations only add.** Removals happen in a later release, once nothing uses the old schema.
- **Core changes get extra scrutiny.** Tasks that touch `packages/core`, migrations in `packages/store`, or the stage rules carry a `core` label.
  They need plan approval and a careful human review.
- **Tests don't spawn real agents.** Automated tests use `fake-agent`. Real providers are opt-in and use the cheapest model.
- **If prod breaks,** every session keeps running in Herdr, Codex and Claude Code. Fix Loom directly with Herdr and Claude, or roll back.
