# Loom

Terminology: an “issue” in the UI is a “task” in the code; internal identifiers and MCP tool names retain `task`.

A local, Linear-style control surface for coding agents. Loom moves issues through
Backlog → Todo → In progress → In review → Awaiting approval → Done, and runs Codex and
Claude Code agents at each stage. It sits on top of GitHub, tmux, the Codex app-server and
Claude Code, and every one of those keeps working on its own.

**Status:** pre-alpha. Phase 2 (adapters) is complete; the coordinator is next (see `docs/build-plan.md`).

- `docs/architecture.md`: the design and the principles behind it
- `docs/build-plan.md`: the build phases, and how Loom starts building itself
- `spikes/`: throwaway experiments that answer open integration questions
- `apps/desktop/`: the window (Phase 1 shell, rendered from fixtures)
- `AGENTS.md`: instructions for agents working in this repo

## Main

Main is the conversation agent behind the bottom-bar toggle (⌘J) and **Open Main** in the
command palette. It introduces itself and waits for you, turns longer work into Loom issues,
and summarizes Needs-you escalations. It has only Loom MCP tools and read-only file tools in
its instance directory, with no shell or terminal attach capability. Its `set_note` tool keeps
up to 2,000 characters in the instance's `main-notes` document across session restarts and rotation.

## Development

Run the dev instance (coordinator and desktop app) with the launcher; both live in windows on the
instance's private tmux server, so they survive your terminal and restart independently:

```sh
pnpm dev:sync               # the one safe command: start what is down, restart what is stale
pnpm dev                    # start both (running ones are left alone)
pnpm dev:restart            # restart both, coordinator first
scripts/dev.sh restart app  # just the app
scripts/dev.sh status       # what is running, whether it is stale, and one app-server per task
scripts/dev.sh logs         # follow the coordinator log
scripts/dev.sh install-launcher   # "Loom Dev.app" in ~/Applications with the same buttons;
                                  # Status shows a dialog, the rest run detached and notify when done
```

Each start records a fingerprint of the sources that process was built from: the coordinator and
`packages/*` for the coordinator; Electron's main, preload and shared code plus `packages/*` for
the app. The renderer hot-reloads and is not part of it. `status` reports STALE when the working
tree differs from the record, and `sync` restarts exactly those. After a merge or an edit, run
`pnpm dev:sync` and nothing else.

It reads `~/.loom/dev/env`, which must export `LOOM_INSTANCE`, `LOOM_DATA_ROOT` and `LOOM_TOKEN`.


```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
```

### Continuous Integration

A GitHub Actions workflow (`.github/workflows/ci.yml`) automatically runs lint, typecheck, and tests on every pull request and push to the main branch. The workflow:

- Installs Node.js 22.13.0 and pnpm 10.0.0 (from `.npmrc` and `package.json`)
- Caches the pnpm store for faster builds
- Installs tmux for tests that require it
- Runs `pnpm lint`, `pnpm typecheck`, and `pnpm test`
- Skips real provider tests and desktop performance tests in CI

To require these checks before merging to main, enable branch protection rules in GitHub:

1. Go to repository **Settings → Branches**
2. Under "Branch protection rules", click "Add rule"
3. Set "Branch name pattern" to `main`
4. Enable "Require status checks to pass before merging"
5. Select the `lint-typecheck-test` job as a required check

### The window

```sh
pnpm --filter @loom/desktop dev     # Electron + Vite, on fixture data
pnpm --filter @loom/desktop build
pnpm --filter @loom/desktop perf    # the Playwright performance harness
```

It renders from an in-memory fixture store and talks to nothing. The Terminal tab runs a real
PTY; set `LOOM_ATTACH_PANE=<session>:<window-id>` to attach it to a pane on Loom's tmux server instead of a shell. See
`apps/desktop/README.md` for the keyboard map, the environment variables and the performance
budgets.
