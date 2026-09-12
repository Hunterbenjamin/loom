# Brief: the Workbench window (every agent terminal, visible)

Read `AGENTS.md`, `docs/design/ui.md` (Modes, Windows, Workbench, Pane host, Performance) and
`apps/desktop/README.md` first. Open one PR. This is the first Workbench slice; keep it to what is
listed here and say in the PR what was deferred.

## Why

The human must be able to see every agent terminal Loom's pane host has open, whether or not Loom
started it for a task: task runs, the Lead, research agents, or anything else on the instance's
private tmux server. Today only task runs are reachable, and only one at a time through a task's
Terminal tab. The Workbench is a second window mode, Herdr-like: a sidebar of spaces and agents,
tabs, split panes, keyboard first.

## What to build

1. **A `panes` protocol view**, coordinator-owned, from the pane host (`PaneHost.listPanes` and
   `listClients` in `packages/adapters/tmux`): every session, window and pane on `-L loom-<instance>`
   with its names and IDs, current command, start cwd, dead/exit state, attached client count, and
   the Loom link when one exists (task ID, run ID, role, provider) — matched through the run's
   recorded pane, never by parsing screen content. Refresh on the pane host's `subscribe` events and
   on a poll no faster than 2 s; deliver as snapshot + patches like the other views. Sessions Loom
   did not start appear too, labelled by their session name.

2. **The Workbench window.** `⌘⇧W` (and a command in the palette and the bottom bar) opens a
   Workbench window; a Tracker window stays a Tracker window. Any number of each may be open.
   - **Sidebar:** a tree of spaces → agents. A space is a tmux session; an agent is a pane. Task
     sessions show the task key and title, the run's role/provider, its status and its attention
     badge from the snapshot (never from the terminal). The Lead's session and unlinked sessions
     show their names. Dead panes are shown dimmed, not hidden. Filter box at the top.
   - **Tabs and splits:** a tab holds a binary split tree of panels, built on a proven dock/grid
     library (dockview or equivalent: tabs, splits, drag). Layout is per window, in memory only.
   - **Panels, v1:** terminal (an xterm.js attached to one pane-host target, via the existing attach
     flow and terminal component, each panel its own client), and a scratch shell in a task's
     worktree (a new pane in that task's session, on the pane host). Plan, diff and activity panels
     reuse the Tracker's existing components if they drop in cheaply; otherwise defer and say so.
   - **Bindings:** prefix `ctrl+a`, then `|` and `-` split, `h j k l` focus, `c` new tab, `n`/`p`
     next/previous tab, `x` close panel, `z` zoom, `g` jump to an agent by name (fuzzy), `?` map.
     Every action is also in the command palette without the prefix. Selecting an agent in the
     sidebar opens it in the focused panel; `enter` opens in a new tab.
   - **Closing a panel detaches; it never stops the agent.** Terminal input goes through the
     existing attach client, so the send gate and the pane host's rules apply unchanged.

3. **Bottom bar** (from the Lead PR) is shared by both modes and shows the count of agents needing
   attention; clicking it in a Workbench window focuses the sidebar's first flagged agent.

## Rules

- Performance budgets in `docs/design/ui.md` hold: keystroke-to-echo p95 ≤ 16 ms in a terminal
  panel with four panels open; opening the window ≤ 300 ms with 30 panes listed; a `panes` patch
  must not re-render terminals. Extend `apps/desktop/perf` with a Workbench case and refresh the
  report.
- No durable state in the renderer (principle 5). Never read or type into panes outside the
  instance's private tmux server; tests use a `loom-test-<pid>` socket.
- Tests: `panes` view assembly against the fake pane host (linked and unlinked sessions, dead
  panes, client counts); sidebar tree selectors; binding map; a renderer test that opening two
  terminal panels creates two attach clients and closing one detaches only that one.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` and the desktop build green. Update
  `docs/design/ui.md` where the implementation diverged from it, in the same PR.
