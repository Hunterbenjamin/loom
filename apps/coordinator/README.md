# @loom/coordinator

One background process per instance. It reads owners, calls the pure core reconciler, commits state,
executes actions and serves agents/windows. [Architecture](../../docs/architecture.md) owns integration
and recovery rules; [core workflow](../../docs/design/core.md) owns decisions and concurrency.

## Running the CLI

From the repository root, `pnpm loom` runs [src/cli.ts](src/cli.ts) with tsx. Use the
[development launcher](../../README.md#development) for a persistent dev coordinator and desktop.
For an explicitly configured isolated instance:

```sh
pnpm loom repo add ~/src/example example/repo
pnpm loom serve
# In another terminal with the same instance environment:
pnpm loom issue create example-repo "Rename the widget" "Rename Widget to Gadget."
pnpm loom issue move <issue> todo
pnpm loom status
pnpm loom attach <issue> implementer  # prints attach argv; --exec runs it
```

`issue` is the public command group; `task` remains a hidden compatibility alias. Issue references
accept canonical `t-…` IDs, repository keys such as `LOOM-12`, or numbers within an unambiguous
repository. Quote descriptions as one argument; `--` ends option parsing.

Useful diagnostics and actions:

```sh
pnpm loom issue list --view needs_you
pnpm loom issue show <issue>
pnpm loom issue inspect <issue> --json
pnpm loom issue timings <issue>
pnpm loom issue restart <issue> <runId>
pnpm loom issue answer <issue> <questionId> <answer>
pnpm loom issue answer-request <issue> <runId> <requestId> accept
```

`inspect` uses a read-only store connection without migrations/recovery and works while the
coordinator is stopped. It reports persisted flags, runs, delivery, questions, approvals, recent
outbox results and findings; it does not refresh providers. Other issue commands are protocol
clients. `serve` and `repo add` are local administration commands.

`restart` explicitly replaces the named current run with current effective agent settings; use
`show` to find its ID. [Agent context](../../docs/design/agents.md#context-and-fix-rounds) explains
what survives a new session. `--small` on creation selects the [small-task path](../../docs/design/core.md#stage-rules).

## Configuration

Required environment:

| Variable | Purpose |
|---|---|
| `LOOM_INSTANCE` | Private instance name |
| `LOOM_DATA_ROOT` | Parent directory of instance state |
| `LOOM_TOKEN` | Protocol authentication token, at least 16 characters |
| `LOOM_BIND` | Optional protocol `host:port`, default `127.0.0.1:47800` |
| `LOOM_MCP_PORT` | Optional stable MCP port, default bind port + 1 |
| `LOOM_HOOK_PORT` | Optional stable Claude-hook port, default bind port + 2 |

For a second checkout and desktop listener configuration, see [instances](../../docs/instances.md).

Set credentials privately; never put actual tokens in commands, logs or repository files. Occupied
stable ports fail startup rather than changing endpoints under live runs. Restart after changing
process environment. Settings precedence and scope are documented in
[architecture](../../docs/architecture.md#settings); [src/config.ts](src/config.ts) is the environment
mapping, including `LOOM_PROVIDER_*`, `LOOM_MODEL_*`, `LOOM_RUN_MODES` and executable overrides.

## WORKFLOW.md

[src/workflow.ts](src/workflow.ts) reads the registered repository root's `WORKFLOW.md`. A
`## <name>` heading followed by a fenced block defines a command; names become lowercase with
spaces folded to underscores. Other content is prose. Missing files expose no commands; malformed
or duplicate commands reject the entire file and produce a warning. The path cache invalidates on
size/mtime changes.

Commands appear in `get_task_context` and supply the exact-command allowlist for
[coordinator automation](../../docs/design/core.md#coordinator-automation). They do not execute merely
because they are listed.

## Source map

| Source | Responsibility |
|---|---|
| [coordinator.ts](src/coordinator.ts) | Compose instance services, startup/shutdown and published state |
| [loop.ts](src/loop.ts), [observe.ts](src/observe.ts) | Reconcile scheduling and owner reads |
| [executor.ts](src/executor.ts), [recovery.ts](src/recovery.ts) | Outbox effects and uncertain-action recovery |
| [launch.ts](src/launch.ts), [recipes.ts](src/recipes.ts) | Provider launch and private saved recipes |
| [mcp-host.ts](src/mcp-host.ts), [prompts.ts](src/prompts.ts) | Task context, submission bridge and role briefs |
| [server.ts](src/server.ts), [commands.ts](src/commands.ts) | Authenticated protocol and command dispatch |
| [pull-requests.ts](src/pull-requests.ts), [conversations.ts](src/conversations.ts) | Subscription-scoped owner projections |
| [pane-inventory.ts](src/pane-inventory.ts), [terminals.ts](src/terminals.ts) | Native inventory and terminal commands |
| [lead.ts](src/lead.ts), [main-messages.ts](src/main-messages.ts) | Main lifecycle and its issue-agent messages |
| [briefs.ts](src/briefs.ts), [settings.ts](src/settings.ts) | Daily research and settings services |

## Diagnostics and verification

Per-issue Codex stderr is retained in `<taskDirectory>/app-server.log` with private permissions.
For stalled work, inspect the recorded attention and delivery state before acting; terminal activity
does not establish provider observability. Unknown observations use the
[recovery contract](../../docs/architecture.md#recovery). Answer Claude folder trust in its native dialog.
Do not repair a live instance by manually rewriting run rows.

Colocated tests cover the real loop/store/executor with temporary Git repos and fake providers;
real provider tests are opt-in under the [repository rules](../../AGENTS.md#checks).
