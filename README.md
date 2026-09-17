# Loom

Loom is a local desktop app and background coordinator for coding agents. It runs issues through
planning, implementation, CI, review and approval, with live terminals and GitHub PR review.
GitHub, tmux, Codex and Claude Code remain independent tools.

The UI calls a unit of work an **issue**; code and MCP tool names call it a **task**.

## Start here

- [Using Loom on a project](docs/using-loom.md): register a repository, prepare instructions and configure its workflow.

- [AGENTS.md](AGENTS.md): repository principles, safety and contribution rules.
- [Architecture](docs/architecture.md): ownership, integrations, recovery and settings.
- [Core workflow](docs/design/core.md): stages, guards and reconciliation.
- [Agents](docs/design/agents.md): Main and issue-agent responsibilities.
- [UI](docs/design/ui.md): Tracker, Workbench and detail pages.
- [Coordinator](apps/coordinator/README.md) and [desktop](apps/desktop/README.md): setup and source maps.

- [Using Loom on a project](docs/instances.md): run a stable instance alongside dev.

## Development

Use the Node version in [.node-version](.node-version) and pnpm version in
[package.json](package.json), then `pnpm install --frozen-lockfile`.
The launcher reads `~/.loom/dev/env`, which must export `LOOM_INSTANCE`, `LOOM_DATA_ROOT` and
`LOOM_TOKEN`. Coordinator and desktop run independently on the instance's private tmux server.

```sh
pnpm dev:sync                    # start missing processes; restart stale ones
pnpm dev                        # start both, leaving running processes alone
pnpm dev:restart                 # restart both, coordinator first
scripts/dev.sh restart app      # restart only the desktop
scripts/dev.sh status
scripts/dev.sh logs
scripts/dev.sh install-launcher  # install Loom Dev.app in ~/Applications
```

After source changes or a merge, use `pnpm dev:sync`. Source fingerprints detect stale coordinator
and Electron main/preload builds; the renderer hot-reloads. The Workbench and command palette
also expose these dev controls when running from a checkout.

[CI](.github/workflows/ci.yml) runs lint, typecheck and tests on every branch push, so submitted
commits get checks before a PR exists. For local checks, see [AGENTS.md](AGENTS.md) and the
repository commands in [WORKFLOW.md](WORKFLOW.md). Issue agents follow their
[role-specific check policy](docs/design/agents.md#issue-agents).
