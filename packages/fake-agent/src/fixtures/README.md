# Scenario fixtures

These are authored scripts, not recordings of real agent executions. The eight JSON files cover
core design §9's example and every fault in the Phase 2 brief. Each file is a scenario set, matched
on provider/role/mode and optional attempt; matching scripts with the same selector are consumed
in file order (for example, successive review rounds).

Native observation values follow the existing adapter recordings:

- `packages/adapters/codex/src/fixtures/traffic.json` and `recorded-0.154.0.json`: idle/active
  snapshots, turn IDs, unloaded threads and connection generations.
- `packages/adapters/claude/src/fixtures/agents.json` and `payload-samples.json`: busy/waiting/idle
  entries, `prompt_id`, hooks, and absent entries without a `SessionEnd` on crash.
- `packages/adapters/github/src/fixtures/checks.http`: check-run IDs are separate from names and
  persist when a check completes. A new head gets a new check ID, even with the same name.
- `packages/adapters/tmux/src/fixtures/list-panes.txt`: pane refs, native dead/exit facts, and start cwd.

No new real-provider measurement was made for this package. Fake commands are intentionally
nonexistent (`fake-codex`, `fake-claude`, `fake-tmux`); the fakes never execute them.
