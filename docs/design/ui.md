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
  question, blocked, vanished) drawn from the snapshot, never from the terminal. This is what a terminal's
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
  can show the same agent at the same time; the pane host allows multiple clients (see below).
  Closing a panel detaches; it never stops the agent.

## Pane host

The pane host keeps agent PTYs alive across window closes and app restarts, lets any number of
clients attach, delivers keys, and starts processes in a worktree with a controlled environment. It
is replaceable behind one adapter interface; the Workbench is its user interface.

[Spike 06](../../spikes/06-tmux-pane-host/FINDINGS.md) measured tmux for this role and it passed, so
tmux is the pane host (`packages/adapters/tmux`). Herdr's one-attached-client rule conflicted with the
multi-window model above, and its agent-awareness duplicated Loom's. The Workbench attaches through a
*grouped* session per view — clients on the same tmux session share its current window, so each view
needs its own — and any number of clients, Ghostty included, may attach to the same pane.
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

## Lead

Every window has a 34px bottom bar: connection state and instance on the left, and a Lead toggle
with the number of Needs-you rows on the right. `⌘J` opens or closes Lead, including while typing
in its terminal. The panel overlays the lower third of the window. Its top edge supports pointer
and arrow-key resizing; height and visibility live only in that window's memory. Closing detaches
that terminal client and leaves the session running. Reopening attaches again. Toggle and resize
state belong to the bar component, so neither updates the task store nor re-renders the task list.
The terminal module loads only when first opened, preserving the cold-start path.

The header shows working, idle or waiting from the coordinator's `claude agents --json` observation.
An absent or unavailable provider observation is unknown, never inferred from terminal output.
Restart stops the session, revokes its token and opens a fresh session through the same attach flow.
Fixture mode previews the bar and terminal without contacting a coordinator or launching an agent.

Lead is one interactive Claude session per instance, not a task run. The coordinator persists its
session ID, private token, launch recipe and per-session settings under `<instance data>/lead/`
before launching in the instance data directory. Its fixed pane workspace is `lead` (`loom-lead`
on the instance's private tmux server). `LOOM_MODEL_LEAD` overrides the configured Claude model.
`open_lead_session` is serialized and idempotent; it returns the existing live attach target or
creates the pane. `stop_lead_session` records the stop before closing the pane. Startup recovery
relaunches a confirmed dead pane from the recipe, resumes a session with a provider-confirmed transcript,
and leaves a missing pane alone until an explicit open. The saved MCP port is rebound on restart
so an existing Lead process keeps its endpoint. A conflicting listener causes startup to fail
rather than silently changing that endpoint.

Lead's token selects a separate MCP tool set on the coordinator's existing host: `list_tasks`,
`inspect_task`, `create_task`, `move_task`, `approve_plan`, `reject_plan`, `approve_merge`,
`request_changes`, `answer_question`, `answer_provider_request`, `retry_task`, `cancel_task`, and
`list_repos`. Inspection uses the same view as `loom task inspect --json`. Mutations use the CLI's
human-command path and keep every core guard; an input acknowledgement means queued, not approved.
Task-run tokens cannot call these tools, and Lead cannot call task-run result tools. Its first
message requires repository work to become Loom tasks and forbids merging or pushing to a base
branch. The task model, core stages and reconciler are unchanged.

## Performance

The Workbench inherits the shell's budgets and harness: keystroke to glyph p95 ≤ 16 ms, 120 fps
scrolling, view switch ≤ 50 ms, cold start ≤ 1.5 s, idle CPU ≤ 3% with six terminals open. A new
window must open in under 300 ms from an already-running coordinator.

## Out of v1

Editing code, drag-and-drop between windows, a third mode, plugins, themes beyond dark and light.
