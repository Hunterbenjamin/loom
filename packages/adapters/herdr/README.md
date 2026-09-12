# @loom/adapter-herdr

`createHerdrAdapter({ socketPath, sessionName })` implements the core Herdr contract
using newline-delimited JSON on a local Unix socket. Supply an explicit socket and
its matching named session; neither is discovered from the caller's environment.
`herdrExecutable` optionally supplies the absolute executable path for terminal attach.
The coordinator owns server startup, lifetime, and durable run intent.

Start Loom's Herdr server with `scrubEnvironment(process.env)` and a private config
containing `[session] resume_agents_on_restore = false`. The adapter never starts,
stops, reconfigures, or upgrades a server. `openWorkspace` requires an existing
directory and reuses a workspace by canonical pane cwd; it never creates a Git
worktree. Multiple matching workspaces are an error. Serialize operations for each
task in the coordinator; this adapter additionally serializes workspace/start
mutations within one instance.

`startAgent.args` contains native provider arguments, equivalent to the arguments
**after** `--` in `herdr agent start`. Allocate and persist the provider session ID
before calling it, and supply the full intended model, resume, remote-server, and
Claude settings arguments on every launch. Call `reportSession` after a Codex resume;
Herdr's integration hook does not supply that reference on resume.

Environment scrubbing happens inside the pane, immediately before provider exec.
The adapter verifies native process metadata for an available Bash/Zsh shell,
installs a pane-local provider function, waits for its private filesystem handshake,
and calls `agent.start`. The function invokes `/bin/bash` without startup files,
removes every `CLAUDE_CODE_*` and `HERDR_*` variable plus `CLAUDECODE`, then execs the
provider with its original argv. Other variables, including `CODEX_HOME`, survive.
No global configuration or shell startup file is changed. Unsupported shells or
occupied panes fail before input is written. This requires a local filesystem shared
with Herdr, `/bin/bash`, `/usr/bin/env`, and `/usr/bin/touch`; remote sockets are not
supported. The function remains in that task's shell for subsequent starts.

Startup returns the Herdr reference plus `startup: ready | blocked | readiness_timeout`.
These describe startup UI only. A blocked result leaves the dialog untouched.
A resumed Codex readiness timeout is recoverable only when native process metadata
matches the exact intended `codex resume … --remote …` argv. The adapter restores
its name, then lets the coordinator confirm status through Codex. If Herdr refuses
rename because startup is still pending, an existing matching name is accepted only
after a fresh read. Transport loss never triggers an automatic mutation replay.

`getAgent`/`listAgents.state` is **screen-derived**, never provider/run status.
Missing cwd is an error, a missing agent is null, and a session reference of kind
`path` is not reported as a provider session ID. Unnamed agents use their pane ID
as their addressable name. `prompt` refuses `/` and `!`, including leading whitespace,
and never sends a wait option. `ok` means text and Enter were written; provider-native
acknowledgement is still required for delivery. Other API failures are raised as
`HerdrError` with a code, without echoing server messages or payloads.

Subscriptions produce session-wide hints with null join keys, so the coordinator
should enqueue its tasks for fresh reads. They carry no event state. Reconnects
resubscribe and invalidate reads to cover missed events; `onError` reports transport
or validation failures. Always call the returned unsubscribe function during shutdown.
Herdr does not emit a subscribed lifecycle event for every session-reference write;
keep periodic reconciliation and explicitly re-read after `reportSession`.

`attachArgs(name)` returns the full argv:
`herdr --session <session> agent attach <name>`. Spawn it in the desktop app's PTY
with a scrubbed environment. Herdr allows **one attached client per terminal**.
A second attach can fail; takeover belongs to the human and this method never adds
`--takeover`. Detaching a terminal does not stop the agent. The desktop app owns
terminal sizing, rendering, attachment errors, and takeover UI.

## Verification

Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` at the repository root. Default
tests use temporary fake Unix socket servers and local shell probes, never real
providers. Socket binding must be allowed by the test environment.

`LOOM_REAL_PROVIDERS=1 pnpm test packages/adapters/herdr/src/real.test.ts` starts
`herdr --session loom-test-herdr server` with a scrubbed environment and a private
config. It refuses an existing session directory, launches Claude with `--model haiku`
and a newly allocated session ID, sends no prompt, and leaves any trust dialog
unanswered. It verifies workspace reuse, startup, session report/readback, observation
listing, subscription setup, and prompt refusal, then cleans up its owned server.
This smoke test passed on Herdr 0.9.0 / protocol 22. A full live Codex resume was not
run for this adapter; that timeout path uses injected process metadata plus the
recorded wire shapes and the spike 05 evidence.

## Contract changes

- `reportSession(paneId, provider, sessionId)` restores provider identity after resume.
- `attachArgs(name)` supplies the embedded terminal command without takeover.
- `startAgent` adds a `startup` result field so callers can surface a dialog or a
  readiness timeout without mistaking either for provider status.

## Observed protocol details

The installed `herdr api schema --json` and the private session were the primary
sources. The [0.9.0 socket documentation](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/socket-api.mdx)
is also useful, but the raw API differs from the CLI startup description:

- `agent.start` returned `agent_started` immediately with `launch_pending: true`.
  Readiness needs fresh `agent.get` reads. The blocked trust-dialog observation
  retained both its name and `launch_pending`.
- `agent.start` has no environment field. Scrubbing only the socket client's
  environment cannot affect a provider launched by the existing pane shell.
- `events.subscribe` acknowledges with `subscription_started`; subscription names
  use dots, while emitted event names and `data.type` use underscores.
- `pane.report_agent_session` accepts an omitted sequence, returns `ok`, and the
  reference is visible in a fresh `agent.get`; repeating it preserves the reference.
- Renaming while `launch_pending` returns `agent_launch_pending`, even for the
  name already assigned to that pane.
