# @loom/desktop

The Loom window: a Linear-style view of tasks, runs, plans, findings and diffs.

The Tracker connects to the coordinator over `@loom/protocol`: authenticated hello, snapshot,
then ordered patches. It retains the last snapshot while disconnected and reconnects with capped
exponential backoff. Selection and open tabs are in memory; the coordinator owns task state.

## Running it

```sh
pnpm install
# Use the same explicitly configured environment as the coordinator CLI:
pnpm --filter @loom/desktop dev
pnpm --filter @loom/desktop build
pnpm --filter @loom/desktop start
# No coordinator, for fixture development:
pnpm --filter @loom/desktop exec electron-vite dev -- --fixtures
```

`LOOM_INSTANCE`, `LOOM_DATA_ROOT`, `LOOM_TOKEN` and `LOOM_BIND` are read in Electron main and
passed through the preload's narrow connection IPC. Instance, data root and token are required;
only bind defaults (`127.0.0.1:47800`, like the CLI). There is no fallback to a stable instance or
local database. `--fixtures` bypasses this connection entirely. For a built fixture window use
`pnpm --filter @loom/desktop exec electron . --fixtures`.

Needs you lists one row per coordinator-derived attention reason, oldest first. Its sidebar badge
and each window's title count reasons, across all tasks (the sidebar respects its repo filter).
`g` then `n` opens the inbox; Enter opens the selected reason's resolving tab. Run-scoped reasons
show role/provider/mode; if several runs share a reason, the detail offers a run selector.

Approve/reject plan, approve merge at the displayed reviewed SHA, request changes, answer question
and retry each send one protocol command. A human acknowledgement means **queued**, not completed;
the detail retains the acknowledgement or rejection, and Activity reflects subsequent transitions.
Commands are never replayed after a disconnect. Existing fixture-only comment/viewed-file controls
and stage simulation cannot mutate the live snapshot. The live Review tab shows the reviewed SHA
and findings; raw diffs/review-state writes remain unavailable in the coordinator's current API.

Live terminals resolve the chosen run ID through `open_attach_session` in main, validate the returned
pane/instance, and run its attach argv. A missing/dead pane shows an error. Closing the panel detaches
only its client. In fixture mode Terminal can use a login shell or `LOOM_ATTACH_PANE` on an explicitly
chosen private `loom-<instance>` socket; the performance scripts pass `--fixtures` themselves.

## Isolated live smoke check

```sh
pnpm --filter @loom/desktop build
pnpm exec tsx apps/desktop/scripts/tracker-smoke.ts
```

This creates a temporary Git repo and data root, runs the coordinator with `LOOM_INSTANCE=dev`,
an ephemeral loopback port and `packages/fake-agent` providers/pane host/GitHub, and launches its
own Electron window and user-data directory. It verifies the live snapshot, inbox shortcut,
window count, Plan routing, approval acknowledgement, reconciled update and retention on disconnect.
It closes and removes its resources in `finally`; no real agent, existing pane or stable instance is
used. A screenshot is written to the system temp directory as `loom-tracker-live.png`. Fake panes
are not attachable terminals; the existing isolated terminal harness covers PTY behavior.

| Variable | Effect |
|---|---|
| `LOOM_INSTANCE`, `LOOM_DATA_ROOT` | Explicit coordinator identity and data root, matching the CLI. |
| `LOOM_BIND`, `LOOM_TOKEN` | Coordinator host:port and authentication token; token is never in a URL. |
| `LOOM_TASKS` | Fixture task count; the performance harness uses 500. |
| `LOOM_WIDTH`, `LOOM_HEIGHT` | Window size at launch. |
| `LOOM_ATTACH_PANE`, `LOOM_TMUX_BIN` | Fixture-only terminal target and executable. |

## Keyboard

Every action is reachable from the keyboard.

| Key | Action |
|---|---|
| `cmd+k` | Command palette (also creates tasks and jumps to one) |
| `g` then `i` / `b` | List / board |
| `g` then `n` | The "Needs you" view |
| `j` / `k` | Move the cursor |
| `enter` | Open the task under the cursor |
| `esc` | Close the palette, the search field, then the issue |
| `c` | Create a task |
| `/` | Search |
| `e` | Change stage |
| `cmd+k`, then "Review changes and findings" | Open Review for the current task |
| `alt+↑` / `alt+↓` | Previous / next file, with focus inside Review |

Review contains the file list, diff and findings together. Its range control shows **Whole branch**;
**Since last review** is unavailable until a previous review range is supplied (the shell fixtures
only contain the whole-branch patch).

## The performance harness

```sh
pnpm --filter @loom/desktop build
pnpm --filter @loom/desktop perf
pnpm --filter @loom/desktop test:terminal
```

It launches the built app with Playwright's Electron driver, drives the real renderer, writes
`perf/report.json`, and exits non-zero when a budget in `perf/budgets.json` is missed. `pnpm test`
then re-checks the committed report against those budgets, so a regression fails the suite even
when nobody reruns the harness.

The terminal regression launches its own `tmux -L loom-test-<pid>` server with no user config and a
shell that redraws continuously. It attaches the built app through a real PTY, shrinks and enlarges
the window, then checks per-frame overflow, stable columns/rows and PTY resize counts. It cleans up
its app and server even on failure, and never attaches to an existing pane or launches an agent.

Two details from spike 03 matter: Electron is launched with
`disable-backgrounding-occluded-windows` (a covered window stalls `requestAnimationFrame` and the
run hangs), and CPU is read from `ps`, because Electron's own `percentCPUUsage` under-reports by
roughly eight times.

## Layout

```
src/main         Electron main: the window and the PTYs. Nothing else.
src/preload      The contextBridge, typed by src/shared/ipc.ts
src/renderer
  fixtures/      the snapshot, built from @loom/core types; deterministic
  store/         one store, one subscription, selectors with memoized derivations
  ui/            sidebar, list, board, detail and its tabs, palette, terminal, diff
perf/            the Playwright harness, its budgets and its last report
```

## Workbench

Command+Shift+W and the shared bottom-bar button toggle the current window between Tracker and
Workbench. The palette also offers mode switching; explicit New Window commands remain separate.
New Tracker is also available in the Tracker palette. `LOOM_WINDOW_MODE=workbench` chooses the initial
window mode independently of live/fixture connection settings. Layouts are memory-only.

The sidebar groups native spaces → tabs → panes, including dimmed dead panes and unlinked spaces.
Task spaces show their task key/title; every row rolls up provider status and coordinator attention.
Main and Operator stay pinned at the bottom. Expansion and fuzzy filtering live in window memory.
A pane click replaces the focused viewer; Enter opens a new tab. Space and tab rows toggle expansion.
Branches, rename, sound/flash and opening a tab row as splits belong to later Workbench v2 slices. Ctrl+A then `| - h j k l c n p x z g ?` controls
splits, focus, tabs, close, zoom, search and help. Ctrl+A Ctrl+A sends the literal prefix; Escape or
1.5 seconds cancels it. Drag headers to panel edges to rearrange splits. Every prefix action has a
Command+K palette entry. Command+J and the Main toggle/restart are shared with Tracker.

Scratch shell creates a native shell in the selected task's recorded worktree/session. Closing a
panel or window only detaches. Plan, diff, activity and code panels are deferred in this slice.
Client counts mean session-group attachments, not exact pane viewers.

`pnpm --filter @loom/desktop test:workbench` runs the built Workbench smoke/performance fixture with
30 native panes, fake provider metadata, and real attach clients on its own `loom-test-<pid>` server.
It checks terminal mount counts during patches/layout changes, four-panel echo latency, six-terminal
idle CPU, independent window closure and scratch creation. It writes `perf/workbench-report.json`.
Run it after the desktop build and separately from other performance harnesses to avoid contention.

Switching modes preserves Tracker selection and Workbench tabs/splits in the same window.
Inactive terminal viewers detach and reattach when shown; the native panes and agents keep running.
The app does not create a hidden spare Workbench window.

Space and tab rows support inline rename: double-click or F2, Enter to submit, Escape to cancel.
Validation and host errors appear in the editor; session names cannot contain `.` or `:`.
The sidebar waits for native inventory patches to update labels, and renaming keeps terminal
viewers attached. Task space labels remain the task title; the tooltip shows the session name.
