# Phase 2: `packages/adapters/tmux`, replacing Herdr as the pane host

**Agent:** claude, Opus · **Branch:** `feat/adapter-tmux` · **PR title:** "Phase 2: tmux pane host,
replacing Herdr". Read [`phase-2-common.md`](phase-2-common.md) first, then
[spike 06's findings](../../spikes/06-tmux-pane-host/FINDINGS.md) in full, especially "Implications
for Loom: proposed `PaneHost`", and [`docs/design/ui.md`](../design/ui.md) for why multiple attached
clients matter.

## Why

Spike 06 measured tmux against the budgets Herdr met and it passed: 5–6 ms keystroke to glyph,
89 of 89 prompts delivered exactly once, two windows and Ghostty attached to one agent at the same
time, and recovery from a killed server in about 30 s using stored IDs alone. Herdr's distinguishing
feature is agent awareness, which Loom provides itself and never trusts from a terminal. tmux is the
pane host from here; this package makes that real and retires the Herdr one.

## Build

1. **The `PaneHost` contract.** Replace `HerdrAdapter` in `packages/core/src/adapters.ts` with the
   `PaneHost` interface spike 06 proposes (`ensureWorkspace`, `ensurePane`, `getPane`, `listPanes`,
   `pasteText`, `sendKey`, `attachArgs`, `listClients`, `closePane`, `subscribe`), adjusted where
   implementing it shows a better shape. Rename `HerdrRef`/`HerdrAgentObservation` and the `herdr`
   fields on `Run` and `RunObservation` to pane-host terms. This is the one Phase 2 brief allowed to
   change core beyond its own interface; list every change under "Contract changes".
2. **The adapter**, over the tmux CLI (and control mode where it helps), on a private server
   `-L loom-<instance>` with a private config loaded before any pane exists: the extended-key, mouse,
   `window-size latest`, `aggressive-resize` and `status off` settings the spike verified.
   - **Sessions:** decide, and test, how tasks map to sessions so two windows can show different
     panes of the same task independently. Spike 06 left grouped sessions unmeasured; measure them.
   - **Environment:** construct the pane's environment as an allowlist, remove inherited names with
     `set-environment -r`, and keep `update-environment` empty. `-e` does not remove variables.
   - **`pasteText`:** a unique buffer per call, chunks bounded in UTF-8 bytes (or `load-buffer -`,
     validated), CRLF normalized before transport, `paste-buffer -p`, then Enter. It returns
     `written` and nothing stronger. It does not check provider state; the coordinator gates sends on
     the provider's status, because a paste into a permission dialog approved the command in the spike.
   - **Exit:** `pane_dead` plus a hook or format subscription, with the notification latency measured.
     `%exit` is not a pane exit.
   - **`attachArgs`:** an explicit socket, session and pane target; no takeover concept.
   - **Discovery:** `listPanes` joins on the realpath of the pane's start path; pane IDs are scoped to a
     host generation because they restart from `%0` after a server death.
3. **Retire Herdr.** Delete `packages/adapters/herdr`. Update `docs/architecture.md` (ownership table,
   components diagram, the embedded-terminal and Herdr rules under "Agent integration", the restart
   row), `AGENTS.md` principle 1 and its safety rules, and `docs/design/core.md` wherever it names
   Herdr, so tmux is the pane host and the multi-client rule replaces the takeover rule. While in
   `core.md` §7, correct the MCP registration wording: Claude ignores `mcpServers` in `--settings`, so
   the token goes in the run's MCP config (`--mcp-config`, or the SDK's `mcpServers`). Keep the spikes
   untouched; they're history.
4. **Port the launchers.** `scripts/agent.sh` and `scripts/spike.sh` currently use Herdr to run this
   project's own agents. Move them to the same private tmux server so we run one multiplexer. Keep
   the launch confirmation that catches a dropped first prompt: for Claude, `claude agents --json`
   showing the session busy; for Codex, the best cheap signal you can justify. Print the attach
   command for each launched agent.

## Tests

Unit tests run against a throwaway tmux server (`-L loom-test-<pid>`, killed afterwards) since tmux
is fast and local; they never touch another server. Cover: config loading, environment allowlisting
verified from inside the pane, chunked paste of 20 KB with a byte-boundary case, CRLF normalization,
`pane_dead` detection and its latency, two clients on one pane, the session-per-task decision, and
generation-scoped pane refs across a `kill-server`. Real-provider tests are opt-in and reuse spike
06's recipes.

## Out of scope

Rendering, the Workbench UI, and the coordinator's send gate itself (document the requirement; the
coordinator implements it).
