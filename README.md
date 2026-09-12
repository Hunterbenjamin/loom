# Loom

A local, Linear-style control surface for coding agents. Loom moves tasks through
Backlog → Todo → In progress → In review → Awaiting approval → Done, and runs Codex and
Claude Code agents at each stage. It sits on top of GitHub, Herdr, the Codex app-server and
Claude Code, and every one of those keeps working on its own.

**Status:** pre-alpha. We're running feasibility spikes (see `docs/build-plan.md`).

- `docs/architecture.md`: the design and the principles behind it
- `docs/build-plan.md`: the build phases, and how Loom starts building itself
- `spikes/`: throwaway experiments that answer open integration questions
- `apps/desktop/`: the window (Phase 1 shell, rendered from fixtures)
- `AGENTS.md`: instructions for agents working in this repo

## Development

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
```

### The window

```sh
pnpm --filter @loom/desktop dev     # Electron + Vite, on fixture data
pnpm --filter @loom/desktop build
pnpm --filter @loom/desktop perf    # the Playwright performance harness
```

It renders from an in-memory fixture store and talks to nothing. The Terminal tab runs a real
PTY; set `LOOM_ATTACH_AGENT=<name>` to point it at `herdr agent attach` instead of a shell. See
`apps/desktop/README.md` for the keyboard map, the environment variables and the performance
budgets.
