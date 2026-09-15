# Loom: agent instructions

Loom is a local desktop app with a background coordinator that runs coding agents (Codex, Claude
Code) through an issue workflow. GitHub, tmux, Codex and Claude Code stay independent tools: Loom
observes and drives them, and never replaces them.

Before changing how Loom talks to an external tool, stores state, or moves tasks between stages,
read the relevant part of `docs/architecture.md`.

## Principles

If a change needs to break one, update `docs/architecture.md` in the same PR and say so in the PR.

1. **One owner per fact.** GitHub owns branches, PRs, CI and merges. Providers own sessions and
   transcripts. The pane host (tmux on a private server) owns terminal processes. The coordinator
   owns tasks, stages, plans, findings, approvals and the links between them.
2. **Reconcile; don't copy events.** An event is a hint to re-read state from its owner, and every
   handler is idempotent.
3. **Code moves tasks between stages.** Agents submit structured results through Loom's MCP tools,
   and code validates them before any transition. Agents never move cards or merge.
4. **Terminals are for humans.** Never decide anything by parsing terminal output; use Codex
   app-server events and Claude Code hooks.
5. **The UI holds no durable state.** Everything survives the window closing and the coordinator
   restarting.
6. **The worktree path is the join key** between a task, its sessions, its panes and its branch.
7. **Record provider session IDs before launch**, so any run can be resumed.

## Fixing problems

Fix the cause, not the symptom: prefer changing or deleting code over adding a layer on top. A new
fallback, retry, timeout, special case or `catch` that discards an error needs a comment naming the
bug it covers and why that bug can't be fixed at its source. Keep one definition per concept: when
two places answer the same question, make one the owner and delete the other.

## Checks

Tests describe current behavior, not requirements. When a change deliberately alters behavior a
test pins, update the test and explain why in the PR; don't preserve an old design just to keep
tests green. In review, a test that defends a workaround or an outdated design is a finding.

`pnpm test`, `pnpm lint` and `pnpm typecheck` must pass before a PR. `packages/core` stays free of
I/O. Validate external input with zod at the boundary. Automated tests never start real agents: use
`packages/fake-agent`; real-provider tests are opt-in with `LOOM_REAL_PROVIDERS=1` and use the cheapest model.

## Safety

Agents run on the same machine as the user's real work.

- Only touch tmux servers named `-L loom-<instance>` or your own `-L loom-test-<pid>`, never the
  default socket. Never stop or reconfigure the user's tmux servers or the shared Codex app-server;
  use a private `codex app-server --listen unix://…` socket for experiments.
- Never read, type into or close panes, agents, threads or sessions you didn't create.
- Never edit global config (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.tmux.conf`); use
  per-process flags and environment variables instead.
- Reach a running Loom instance only through the MCP tools you were given.
- No force-pushes and no pushes to `main`. Merge only when the human has told you to in this
  session, and only after CI is green.
- Keep secrets, tokens and email addresses out of commits, logs and findings.

## Git

Branches are `<type>/<slug>` with type `feat`, `fix`, `docs`, `chore` or `spike`. Keep PRs small and
say what changed, why, and how you tested it.
