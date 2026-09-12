# UI design

Tracker and Workbench are independently opened, fixed-mode windows on the same coordinator.
This note describes the first terminal Workbench slice.

## Modes

| Mode | Use | Input | Status |
|---|---|---|---|
| **Tracker** | Tasks, the Needs-you inbox, git and PR state, plan approval, diff review | Mouse-friendly, Linear-like density; keyboard for everything too | Live and fixture shell |
| **Workbench** | Where the human talks to agents: a keyboard-first multiplexer with a task-aware sidebar, tabs and split panes | Keyboard first, tmux-style prefix bindings | Terminal slice |

A **Code** panel (file tree plus a read-only viewer) lives inside the Workbench as a panel type, not a
third mode. Agents write; the human reads and reviews. Editing is out of v1.

## Windows

Every window has its own coordinator connection and immutable Tracker or Workbench mode.
Command+Shift+W, the command palette, and the bottom-bar Workbench button open a new Workbench.
The palette also offers New Tracker. Existing windows keep their mode.

Tabs, splits, focused panel, filter and zoom exist only in that window's memory. Closing a window
loses its layout and detaches its terminal clients; the underlying pane-host processes survive.
New windows read the coordinator's cached, published inventory, without scanning the host on connect.
After the first live window paints, the app prepares one hidden, empty Workbench with its own
connection. Opening consumes that prepared window and prepares its replacement after a second.
This keeps command-to-usable presentation within the opening budget; preparation time is recorded
separately in the performance report. Fixture startup does not prepare a spare window.

## Workbench

- **Sidebar:** native tmux sessions (spaces) → canonical physical panes. Recorded task workspaces
  show a task label; Lead and unlinked sessions keep their native names. Run linkage is only by a
  unique recorded generation + pane ID, never cwd, title, command or native run tags. Dead panes
  remain visible and dimmed. Filtering matches session/task/role/provider/pane names; each word
  supports ordered-character fuzzy matching. Clicking replaces the focused panel's target; Enter
  opens the agent in a new tab.
- **Tabs and splits:** each outer tab owns a Dockview 4.13.1 Gridview. Splitting replaces a leaf
  with two panels; the library handles sizing and may flatten equivalent adjacent axes. Drag a
  panel header to an edge of another panel in the same tab to move it. Terminal mounts live as
  stable siblings over the library's cells, so moving cells, switching tabs and zooming do not
  dispose attach clients. Layout never leaves the window.
- **Panel types in this slice:** terminal and task scratch shell. Scratch resolves the stored
  worktree and existing workspace in the coordinator and creates an idempotent native shell pane.
  It is not a provider run. Closing its panel leaves the shell running. Plan, diff, activity and
  code panels are deferred; Tracker retains its existing review surface.
- **Bindings:** Ctrl+A then `|` / `-` splits right/down; `h j k l` focuses left/down/up/right;
  `c` opens an empty tab; `n` / `p` switches tabs; `x` closes a panel; `z` toggles zoom;
  `g` focuses the fuzzy agent filter; `?` opens the map. The prefix expires after 1.5 seconds;
  Escape cancels it, Ctrl+A Ctrl+A sends a literal Ctrl+A, and an unknown suffix cancels and
  passes through normally. Each action has the same dispatcher in the Command+K palette.
  Directional focus returns input focus to xterm. Command+J toggles the shared Lead panel.
- **Attention:** the separate agent count counts distinct flagged panes from coordinator attention,
  including Lead's native waiting status. It does not count reason rows. Workbench attention
  navigation clears any hiding filter and selects the first flagged pane in sidebar order.
  The Lead toggle retains Tracker's existing inbox reason count and restart behavior.
- **Terminals:** each panel owns an independent authenticated attach client. Replacing/closing a
  panel kills only that client. Electron keys resources by webContents and panel/client identity,
  including pending spawns and late exit callbacks. Metadata patches update labels without
  rendering or remounting terminal components; theme changes update xterm options in place.

## Pane host

The pane host keeps agent PTYs alive across window closes and app restarts, lets any number of
clients attach, delivers keys, and starts processes in a worktree with a controlled environment. It
is replaceable behind one adapter interface; the Workbench is its user interface.

[Spike 06](../../spikes/06-tmux-pane-host/FINDINGS.md) measured tmux for this role and it passed, so
tmux is the pane host (`packages/adapters/tmux`). Herdr's one-attached-client rule conflicted with the
multi-window model above, and its agent-awareness duplicated Loom's. The Workbench attaches through a
*grouped* session per view — clients on the same tmux session share its current window, so each view
needs its own — and any number of clients, Ghostty included, may attach to the same pane.
tmux 3.7c clients use `active-pane`, with explicit client-local selection initialization, so
existing sibling panes in one native window receive independent input. Grouped aliases and Loom's
control-monitor session are excluded from the logical inventory. Attached-client counts describe
session-group membership, not the number of viewers focused on a particular pane. Observation
failures retain the last good rows with an unavailable flag, including an explicit inventory health
row when the last good inventory was empty. Host hints and metadata changes invalidate one serialized
refresh; a 2-second poll catches changes without hints. Unchanged observations publish no patches.

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
relaunches a confirmed dead pane from the recipe, resumes a session with a provider-confirmed
transcript, and leaves a missing pane alone until an explicit open. The configured stable MCP port
takes precedence; an instance using ephemeral ports rebinds the saved Lead port on restart so an
existing process keeps its endpoint. Lead settings are rewritten during recovery to use the current
endpoint. A conflicting listener causes startup to fail rather than silently changing that endpoint.

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
