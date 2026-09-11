# Loom

A local, Linear-style control surface for coding agents. Loom moves tasks through
Backlog → Todo → In progress → In review → Awaiting approval → Done, and runs Codex and
Claude Code agents at each stage. It sits on top of GitHub, Herdr, the Codex app-server and
Claude Code, and every one of those keeps working on its own.

**Status:** pre-alpha. We're running feasibility spikes (see `docs/build-plan.md`).

- `docs/architecture.md`: the design and the principles behind it
- `docs/build-plan.md`: the build phases, and how Loom starts building itself
- `spikes/`: throwaway experiments that answer open integration questions
- `AGENTS.md`: instructions for agents working in this repo

## Development

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
```
