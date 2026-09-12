# Phase 2: `packages/adapters/herdr`

**Agent:** codex · **Branch:** `feat/adapter-herdr` · **PR title:** "Phase 2: Herdr adapter". Read
[`phase-2-common.md`](phase-2-common.md) first, then spike 03 and spike 05's findings in `spikes/`.

## Build

Implement `HerdrAdapter` from `packages/core/src/adapters.ts` over Herdr's socket API
(newline-delimited JSON over the unix socket; `herdr api schema --json` prints the schema), not by
shelling out to the CLI for every call.

- `openWorkspace`: on an existing worktree path (git creates worktrees; Herdr only opens them).
- `startAgent`: with a **scrubbed environment**, no `CLAUDE_CODE_*` or `HERDR_*` variables (spike
  03 showed an inherited one silently disables transcript saving). Native args after `--`. Handle
  the two startup outcomes the spikes saw: the folder-trust dialog (the agent is blocked before its
  first prompt; report it, never answer it) and the readiness timeout on a resumed Codex TUI (the
  process is up; name it with `agent rename` and continue).
- `prompt`: refuse text starting with `/` or `!` (spike 02: `!` runs a shell command with no
  permission prompt). Map Herdr's results to `HerdrPromptResult`. **Never use `--wait`** (spike 05:
  it hangs on stale status).
- `interrupt`: `send-keys esc`.
- `getAgent`, `listAgents`: `HerdrAgentObservation`, with the state clearly labeled as screen-derived.
- `subscribe`: `events.subscribe` on the socket, delivering hints only.
- Add and implement `reportSession(paneId, provider, sessionId)` for
  `pane report-agent-session --source herdr:<provider>`; the design needs it after every Codex
  resume. List it under "Contract changes".
- Add `attachArgs(name)` returning the command for an embedded terminal, and document the
  one-attached-client rule from spike 03.

## Tests

Unit tests run against a fake socket server that replays recorded responses (record them from a
private named session). Cover: the scrubbed environment, the `/` and `!` refusals, both startup
outcomes, event subscription, and `reportSession`. Opt-in real tests use `herdr --session
loom-test-herdr server` and never the default session.

## Out of scope

Rendering a terminal, takeover UI, and anything that decides from `state`.
