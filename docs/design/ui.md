# UI design

The window has two modes, and can be open more than once. This note records the direction agreed on
2026-09-12 so the Phase 4 briefs derive from it. The Tracker mode exists (`apps/desktop`, on fixtures);
the Workbench is new.

## Modes

| Mode | Use | Input | Status |
|---|---|---|---|
| **Tracker** | Tasks, the Needs-you inbox, git and PR state, plan approval, diff review | Mouse-friendly, Linear-like density; keyboard for everything too | Built as the fixture shell |
| **Workbench** | Where the human talks to agents: a keyboard-first multiplexer with a task-aware sidebar, tabs and split panes | Keyboard first, tmux-style prefix bindings | To build |

A **Code** panel (file tree plus a read-only viewer) lives inside the Workbench as a panel type, not a
third mode. Agents write; the human reads and reviews. Editing is out of v1.

## Windows

Every window is a client of the same coordinator snapshot; none holds durable state (architecture
principle 5). On a large monitor, two windows, each pinned to a mode. On a laptop, one window and
`cmd+1` / `cmd+2` to switch. Opening a window is instant because the snapshot is already in memory in
the coordinator; the window only renders it.

Window layouts, pinned modes, open tabs and split arrangements are per-window conveniences. They are
saved locally so a window reopens as it was, and they are always reconstructible from the snapshot,
so losing them costs nothing.

## Workbench

```
┌ sidebar ──────┬ tabs ─────────────────────────────────────────────┐
│ ▾ loom        │ [LOOM-12 impl] [LOOM-12 review] [LOOM-9 impl]     │
│   ▾ LOOM-12   ├───────────────────────────┬───────────────────────┤
│     ● impl ⚠  │                           │                       │
│     ○ review  │   terminal: LOOM-12 impl  │  diff: LOOM-12        │
│   ▸ LOOM-9    │                           │                       │
│ ▸ bloom       ├───────────────────────────┴───────────────────────┤
│               │   plan: LOOM-12                                   │
└───────────────┴───────────────────────────────────────────────────┘
```

- **Sidebar:** repos → tasks → runs, with the run's status and attention badge (needs permission,
  question, blocked, vanished) drawn from the snapshot, never from the terminal. This is what Herdr's
  sidebar shows for agents, made task-aware.
- **Tabs and splits:** a tab holds a binary split tree; every leaf is a panel. Layout comes from a
  proven grid library (dockview-style: tabs, splits, drag), not hand-rolled.
- **Panel types:** terminal (an xterm.js attached to one pane-host target), diff (Pierre, as in the
  Tracker's review), plan, activity, code (tree plus read-only CodeMirror viewer; Monaco is too heavy
  for the budget), and a scratch shell in the task's worktree.
- **Bindings:** a prefix key (default `ctrl+a`), then `|` and `-` to split, `h j k l` to move focus,
  `c` new tab, `n` / `p` next and previous tab, `x` close panel, `z` zoom, `g` jump to a run by name,
  `?` for the map. Chosen to match tmux so muscle memory transfers to a raw terminal. Everything is
  reachable without the prefix through the command palette.
- **Terminals:** each terminal panel is its own attach client. Two windows, and a Ghostty window,
  can show the same agent at the same time; the pane host must allow multiple clients (see below).
  Closing a panel detaches; it never stops the agent.

## Pane host

The pane host keeps agent PTYs alive across window closes and app restarts, lets any number of
clients attach, delivers keys, and starts processes in a worktree with a controlled environment. It
is replaceable behind one adapter interface; the Workbench is its user interface.

Spike 06 measures tmux for this role. Herdr's one-attached-client rule conflicts with the multi-window
model above, and its agent-awareness duplicates Loom's, so if tmux meets the budgets it replaces Herdr.
The coordinator owning PTYs itself stays a later option if the multiplexer's redraw layer ever shows
in the latency numbers.

## What the protocol must carry

`packages/protocol` is designed for several windows at once. Beyond the entities in
`docs/design/core.md`:

- a snapshot plus patches to N clients, with per-client subscriptions so a window showing one task
  isn't sent every diff of every task;
- attention with a `since` **per reason**, so the inbox and the sidebar can sort by how long each
  thing has waited (the fixture shell found the single `since` ambiguous);
- for every run, its attach target and its pane-host state (attached clients, exited);
- a changed-files model per task: path, previous path, status, binary, counts, stable file ID and a
  monotonic version, taken from Git metadata, since Pierre ignores a file whose version didn't change;
- comment threads on findings, review-shell state (viewed files, drafts, current file), and the
  review range (whole branch versus since the last round), all coordinator-owned so they survive a
  window closing;
- an exported attention derivation in `packages/core`, so the UI never re-implements the rule.

## Performance

The Workbench inherits the shell's budgets and harness: keystroke to glyph p95 ≤ 16 ms, 120 fps
scrolling, view switch ≤ 50 ms, cold start ≤ 1.5 s, idle CPU ≤ 3% with six terminals open. A new
window must open in under 300 ms from an already-running coordinator.

## Out of v1

Editing code, drag-and-drop between windows, a third mode, plugins, themes beyond dark and light.
