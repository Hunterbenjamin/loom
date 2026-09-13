# Loom: agent instructions

Loom is a local desktop app with a background coordinator. The coordinator runs coding agents
(Codex, Claude Code) through a task workflow, and the app is a Linear-style view of that work.
GitHub, tmux, Codex and Claude Code stay independent tools. Loom observes and drives them; it
doesn't replace them.

**Current phase: 3, the walking skeleton** (see `docs/build-plan.md`). `packages/core` holds the
reconciler and the contracts, and `docs/design/core.md` is their specification; `apps/coordinator` is
the process that runs them, and its README says how. Your brief is the file named when you were
launched, under `docs/briefs/`; Phase 2 briefs share `docs/briefs/phase-2-common.md`. The spikes in
`spikes/` are finished reference material, never imported.

**How Loom is built right now:** off its own pipeline. Loom work is done by agents launched
directly into worktrees (`scripts/agent.sh`, or a session opened by hand) and reviewed by a human.
Loom's coordinator only runs sandbox smoke tasks (`scripts/smoke.sh`) until the checklist in
`docs/self-hosting-readiness.md` passes; see "Until then: two tracks" in `docs/build-plan.md`.

Read `docs/architecture.md` before any change to how Loom talks to external tools, stores state,
or moves tasks between stages.

## Principles

If you need to break one of these, update `docs/architecture.md` in the same PR and say so in the PR description.

1. **One owner per fact.**
   - GitHub owns branches, PRs, CI and merges.
   - Providers own sessions and transcripts.
   - The pane host (tmux, on a private server) owns terminal processes.
   - The coordinator owns tasks, stages, plans, findings, approvals, and the links between them.
2. **Reconcile; don't copy events.** An event is a hint to re-read state from its owner. Every handler
   must be idempotent: running it twice has the same effect as running it once.
3. **Code moves tasks between stages.** Agents submit structured results through Loom's MCP tools,
   and code validates them before any transition. Agents never move cards or merge.
4. **Terminals are for humans.** Never make decisions by parsing terminal output. Use provider-native
   channels: Codex app-server events and Claude Code hooks.
5. **The UI holds no durable state.** Everything must survive the window closing and the coordinator
   restarting.
6. **The worktree path is the join key** between a task, its sessions, its panes and its branch.
7. **Record provider session IDs before launch**, so any run can be resumed.

## Repo layout

These directories are planned. Each one is created when its first code lands.

```
packages/core          stage rules + reconciler; pure logic, no I/O
packages/store         SQLite schema + migrations
packages/protocol      typed coordinator ↔ UI API (zod)
packages/adapters/*    codex, claude, tmux, github, git
packages/mcp           MCP tools that agents call
packages/fake-agent    scripted provider used by tests
apps/coordinator       background process + CLI (`loom`)
apps/desktop           Electron app
spikes/                throwaway experiments; never imported by packages
docs/                  architecture and build plan
```

## Commands

```sh
pnpm install
pnpm test        # vitest; tests live next to the code as *.test.ts
pnpm lint        # biome
pnpm typecheck
```

Run all three before opening a PR.

## Conventions

- TypeScript, strict, ESM, Node 22 or later. Validate every external input with zod at the
  boundary: CLI JSON output, hook payloads, protocol messages.
- Keep `packages/core` free of I/O so it can be tested exhaustively.
- Match the surrounding code's style. Keep modules small, and don't add abstractions ahead of need.
- Automated tests never start real agents; they use `packages/fake-agent`. Real-provider
  tests are opt-in (`LOOM_REAL_PROVIDERS=1`) and use the cheapest model.

## Safety rules

Agents working on this repo run on the same machine as the user's real work.

- Never stop, restart or reconfigure the user's own tmux servers or the shared Codex app-server
  daemon. tmux servers are addressed by socket: only ever touch `-L loom-<instance>` or a
  throwaway `-L loom-test-<pid>` of your own, never the default socket. For Codex experiments, use
  a private `codex app-server --listen unix://…` socket.
- Never read, type into or close panes, agents, threads or sessions you didn't create.
- Never edit global config (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.tmux.conf`).
  Use per-process flags instead: `claude --settings`, `codex -c`, `tmux -L … -f …`, environment variables.
- Once the coordinator exists, development instances will run with `LOOM_INSTANCE=dev` and their own data directory and
  ports. Only reach the stable instance through the MCP tools you were given.
- No force-pushes, no pushes to `main`, no merging. Open a PR and let a human merge it.
- Keep secrets, tokens and email addresses out of commits, logs and findings.

## Git

- Name branches `<type>/<slug>`, where type is one of `feat`, `fix`, `docs`, `chore` or `spike`.
- Keep PRs small, and describe what changed, why, and how you tested it.
