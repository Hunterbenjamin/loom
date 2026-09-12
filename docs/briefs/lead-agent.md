# Brief: the Lead agent (bottom bar toggle)

Read `AGENTS.md`, `docs/design/ui.md`, `docs/design/core.md` §"MCP" and `packages/mcp` first.
Open one PR; update `docs/design/ui.md` with a "Lead" section in the same PR.

## Why

The human's primary conversation is with one agent that plans, creates Loom tasks, answers
agents' prompts, reviews PRs and reports, and delegates everything else. Today that role is
played by a Claude Code session in a separate terminal, with no view of Loom except the CLI. It
belongs inside the app: a Linear-style toggle in a bottom bar opens a panel with this agent.

## Model (decided; do not redesign)

- The Lead is **not a task run**. Core, stages and the reconciler do not change. It is one
  interactive Claude Code session per instance, owned by the coordinator, on the pane host under a
  fixed workspace `lead` (tmux session `loom-lead` on the instance's private server), launched with
  per-session `--settings` and `--mcp-config` files exactly like a task run (`packages/adapters/claude`
  `writeSettingsFiles`), a recipe under the data directory, and `--permission-mode acceptEdits`.
  Its cwd is the instance's data directory, not a repository.
- The coordinator gets two protocol commands: `open_lead_session` (idempotent: launches if the
  pane is absent or dead, else returns the existing attach target, the same shape
  `open_attach_session` returns) and `stop_lead_session`. Recovery treats the Lead pane like an
  interactive run's pane (relaunch from recipe when dead; never on mere absence).
- The Lead's MCP token identifies a **lead identity**, not a run. `packages/mcp` gains a second
  tool set, served on the same host and gated by that identity:
  `list_tasks`, `inspect_task` (same data as `loom task inspect --json`), `create_task`,
  `move_task`, `approve_plan`, `reject_plan`, `approve_merge`, `request_changes`,
  `answer_question`, `answer_provider_request`, `retry_task`, `cancel_task`, `list_repos`.
  Each is a thin wrapper over the existing human commands and read views; every guard stays in
  core. Task-run tools (`submit_plan` etc.) are refused for the lead identity and vice versa.
- The Lead's first message (from `apps/coordinator/src/prompts.ts`) says what it is, lists its
  tools, and states the rules: it never merges, never pushes to a base branch, and always creates
  tasks for work rather than editing repositories itself. Model: `LOOM_MODEL_LEAD`, defaulting to
  the configured Claude model.

## UI

- A bottom bar across every window (Tracker and, later, Workbench): left, connection state and the
  instance name; right, the **Lead toggle** with the count of Needs-you rows as a badge.
  Shortcut: `⌘J`. The toggle opens a panel that slides up over the lower third of the window
  (resizable by drag, remembered per window in memory only) containing the Lead's terminal,
  attached with the existing terminal component and attach flow (`open_lead_session`). Closing the
  panel detaches; the session keeps running. Reopening reattaches.
- The panel's header shows the Lead's status from `claude agents --json` (working / idle /
  waiting) and a "restart" action (`stop_lead_session` then `open_lead_session`).
- Performance budgets in `docs/design/ui.md` hold: toggling must not re-render the task list.

## Tests

- MCP: lead tools call the same human-command path the CLI uses; a run token cannot call lead
  tools and a lead token cannot call run tools.
- Coordinator: `open_lead_session` is idempotent and survives a coordinator restart (recipe
  relaunch), against the fake pane host.
- Desktop: bottom bar renders in fixture and live mode; toggle attaches and detaches without
  changing the list's render count.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. Never touch the user's stable instance or
  default tmux server; use `loom-test-<pid>` sockets in tests.
