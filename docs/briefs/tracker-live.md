# Brief: Tracker on the live coordinator, with a Needs-you inbox

Read `AGENTS.md`, `docs/design/ui.md` (Modes, Windows, "What the protocol must carry") and
`packages/protocol/README.md` or its source first. Open one PR.

## Why

The Tracker shell in `apps/desktop` renders fixtures. Every real task so far stalled at least once
(a permission prompt, a question, an unknown provider status) and nobody would have known without
polling the database by hand. The first thing the app must do for real is answer "what needs me
right now, and where do I go to deal with it".

## What to build

1. **Connect the renderer to the coordinator.** Replace the fixture snapshot with a live one over
   `packages/protocol`: `hello` with the token, subscribe, apply the snapshot and then patches to the
   renderer store. Address, instance and token come from the same environment the CLI uses
   (`LOOM_INSTANCE`, `LOOM_DATA_ROOT`, `LOOM_TOKEN`, `LOOM_BIND`); read them in the main process and
   hand them to the renderer through the existing preload/IPC, never by exposing `process.env` to
   the renderer. Reconnect with backoff; show a small "disconnected" state in the sidebar rather
   than an empty list. Keep the fixtures for tests and for a `--fixtures` dev flag.

2. **Needs-you inbox.** A view (sidebar entry, keyboard shortcut) listing every task with a
   non-empty `attention.reasons`, one row per reason, sorted by `reasonSince` oldest first. Each row
   shows: reason (human wording, see the table below), task title, how long it has waited, the run
   involved (role, provider, mode) when the reason belongs to a run. Selecting a row opens the task
   detail on the tab that resolves it: Plan for `plan_needs_approval`, Review for `needs_approval`,
   Terminal (attached to the run's pane) for `provider_permission` / `provider_input` /
   `question` on an interactive run, Activity otherwise. Use `packages/core`'s attention derivation
   through the protocol; do not re-derive it in the renderer.

   | reason | wording |
   |---|---|
   | plan_needs_approval | Plan waiting for approval |
   | needs_approval | Merge waiting for approval |
   | question | Agent asked a question |
   | provider_permission | Agent waiting on a permission prompt |
   | provider_input | Agent waiting for input |
   | blocked | Blocked |
   | failed | Failed |
   | run_vanished | Agent session vanished |
   | stalled | No activity |
   | status_unknown | Status unknown |
   | over_budget | Over budget |

3. **Act from the inbox** with the commands the CLI already has: approve / reject plan, approve
   merge (at the reviewed SHA shown in the row), request changes, answer a question, retry. Each is
   one protocol command; the UI shows the outcome the coordinator returns and never assumes
   success. `git`/`gh` are never called from the app.

4. **Badge and title.** The sidebar entry shows the count; the window title carries it too
   (`Loom · 3 need you`), so a second window on another task still shows it.

## Rules

- Performance budgets in `docs/design/ui.md` hold: applying a patch must not re-render the list;
  use the existing memoised selectors and add tests for new ones.
- No durable state in the renderer (principle 5). Selection and the open tab may live in memory.
- Never touch the user's stable instance. Run the dev instance yourself only through the fake
  agent (`packages/fake-agent`) if you need a live coordinator for a manual check; document how.
- Tests: protocol client (connect, snapshot, patch, reconnect) against an in-process server;
  selectors for the inbox ordering and per-reason rows; a renderer test that the inbox routes each
  reason to the right tab. `pnpm test`, `pnpm lint`, `pnpm typecheck` green.
- If the protocol lacks something the inbox needs (per-reason `since` is already there; attach
  targets per run may not be), add it in `packages/protocol` and the coordinator's server in the
  same PR, with a test, and say so in the PR description.
