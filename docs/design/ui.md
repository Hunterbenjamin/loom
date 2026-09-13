# UI design

Each window switches between Tracker and Workbench on the same coordinator.
This note describes the first terminal Workbench slice.

## Modes

| Mode | Use | Input | Status |
|---|---|---|---|
| **Tracker** | Tasks, the Needs-you inbox, git and PR state, plan approval, diff review | Mouse-friendly, Linear-like density; keyboard for everything too | Live and fixture shell |
| **Workbench** | Where the human talks to agents: a keyboard-first multiplexer with a task-aware sidebar, tabs and split panes | Keyboard first, tmux-style prefix bindings | Terminal slice |

A **Code** panel (file tree plus a read-only viewer) lives inside the Workbench as a panel type, not a
third mode. Agents write; the human reads and reviews. Editing is out of v1.

## Windows

Every window has its own coordinator connection. Command+Shift+W and the bottom-bar mode button
switch that same window between Tracker and Workbench; the button names the destination mode.
The palette provides the same switch and explicit New Window commands remain separate.

Both modes share the window's task store. Tracker selection and Workbench tabs/splits survive a
round trip. Inactive mode effects are suspended: terminal viewers detach while hidden and attach
again when shown, without stopping their native panes or agents. No hidden spare window is created.
Closing a window closes only its viewers; the coordinator owns durable task state.

## Tracker list

Stage headers are buttons: click or press Enter/Space to collapse or expand them. Each header
always shows the total matching task count. Done and Canceled start with the 20 most recently
transitioned tasks, ordered by `stageEnteredAt` descending; Load N more reveals the next 20 (or
the remaining count). Other stages remain unlimited and follow the selected column sort.
Collapse and loaded-page settings stay in each window's memory, including across view switches;
new windows start expanded with the initial limit. Keyboard task navigation skips collapsed and
unloaded rows. Task summaries, model labels and progress indicators remain visible per row.

## Workbench

- **Sidebar:** a native space → tab → pane tree, grouped by host generation/session and window
  identity. Task spaces show the recorded task key/title; unlinked spaces show the session name.
  Tabs show native window names; panes show their command or recorded role · provider and state.
  Main and Operator are pinned at the bottom. Expansion is per-window memory; fuzzy filtering
  reveals matching descendants and their ancestors without changing saved expansion. Native dead
  panes remain dimmed and disabled. Run linkage is only by a unique recorded generation + pane ID,
  never cwd, title, command or native run tags. Clicking a pane replaces the focused viewer; Enter
  opens an independent Workbench tab. Pinned agent tabs retain their identity, so selecting another
  pane from one opens a regular tab. Space and tab rows toggle expansion in this slice; tab-row
  split opening and context menus are deferred to Workbench v2 slice 5.
- **Indicators:** every tree row uses ◌ working, ◐ blocked/needs you, ✓ finished turn/ended,
  ○ idle, ! failed, or ? unknown. Tabs and spaces roll up needs-you > failed > unknown > working >
  done > idle across all descendants, including ones hidden by filtering. Only published provider
  status and coordinator attention determine indicators; native process exit alone is not agent
  completion. Branches, rename, sound and flash remain separate Workbench v2 slices.
- **Tabs and splits:** each outer tab owns a Dockview 4.13.1 Gridview. Splitting names and creates
  an independent terminal, then adds its viewer next to the focused panel; the library handles sizing. Drag a
  panel header to an edge of another panel in the same tab to move it. Terminal mounts live as
  stable siblings over the library's cells, so moving cells, switching tabs and zooming do not
  dispose attach clients. Layout never leaves the window.
- **Panel types in this slice:** terminal and task scratch shell. Scratch resolves the stored
  worktree and existing workspace in the coordinator and creates an idempotent native shell pane.
  It is not a provider run. Close terminal ends its native session and removes it from the list. Plan, diff, activity and
  code panels are deferred; Tracker retains its existing review surface.
- **Bindings:** Main reads and watches `<LOOM_DATA_ROOT>/<instance>/keybindings.json`.
  First launch writes the complete defaults. Zod validates the whole file; invalid JSON,
  unknown/missing actions, invalid chords, duplicate bindings or an invalid timeout activate
  defaults and show an error in the Workbench bottom bar. Saving a valid file updates every
  open window, including its shortcut map and palette. This file is user configuration;
  it stores no layout or task state.
  Ctrl+A then `|` / `-` splits right/down; `h j k l` focuses left/down/up/right;
  `c` names and creates a terminal; `n` / `p` switches tabs; `x` closes a terminal
  (or hides a supervised agent view); `z` toggles zoom; `g` focuses the fuzzy agent filter;
  `?` opens the map. The configurable prefix expires after **3 seconds** by default, with
  an armed indicator in the bottom bar. Modifier presses preserve it. Escape or window blur
  cancels it; an unknown suffix cancels and passes through. Ctrl+A Ctrl+A sends literal Ctrl+A
  to the focused terminal. Repeated keydowns do not repeat commands; composition is left alone.
  Direct Mac defaults: Cmd+D / Cmd+Shift+D split right/down; Cmd+Alt+Arrow focuses a direction;
  Cmd+T names a new tab; Cmd+Shift+] / Cmd+Shift+[ switches next/previous tab; Cmd+W closes the
  panel; Cmd+Shift+Enter zooms; Cmd+P finds an agent; Cmd+K opens the command palette.
  One window capture listener handles terminals, sidebar inputs, tabs and panel headers before
  xterm's custom handler or kitty encoding. Main suppresses competing Electron menu accelerators
  for configured keys in Workbench (especially Cmd+W), while preserving unbound menu shortcuts.
  Native naming dialogs and the command palette keep their own input handling.
  Directional focus returns input focus to xterm. Cmd+J (Main) and Cmd+Shift+W (window mode)
  remain reserved app shortcuts. The editable format is documented in the desktop README.
- **Attention:** the separate agent count counts distinct flagged panes from coordinator attention,
  including Main's native waiting status. It does not count reason rows. Workbench attention
  navigation clears any hiding filter and selects the first flagged pane in sidebar order.
  The Main toggle retains Tracker's existing inbox reason count and restart behavior.
- **Terminals:** each panel owns an independent authenticated attach client. Mode/window teardown
  kills only that client. Explicit Close terminal also asks the coordinator to end the native pane. Electron keys resources by webContents and panel/client identity,
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

## Main

Every window has a 34px bottom bar: connection state and instance on the left, and a Main toggle
with the number of Needs-you rows on the right. `⌘J` opens or closes Main, including while typing
in its terminal. The panel overlays the lower third of the window. Its top edge supports pointer
and arrow-key resizing; height and visibility live only in that window's memory. Closing detaches
that terminal client and leaves the session running. Reopening attaches again and, if native status is idle with no pending dialog, requests a short
Needs-you summary. The palette command **Open Main** opens the same panel. Toggle and resize
state belong to the bar component, so neither updates the task store nor re-renders the task list.
The terminal module loads only when first opened, preserving the cold-start path.

The header shows working, idle or waiting from the coordinator's `claude agents --json` observation.
An absent or unavailable provider observation is unknown, never inferred from terminal output.
Restart stops the session, revokes its token and opens a fresh session through the same attach flow.
Fixture mode previews the bar and terminal without contacting a coordinator or launching an agent.

Main is one interactive Claude session per instance, not a task run. The coordinator persists its
session ID, private token, launch recipe and per-session settings under `<instance data>/lead/`
before launching in the instance data directory. Its fixed pane workspace is `lead` (`loom-lead`
on the instance's private tmux server). `LOOM_MODEL_LEAD` overrides the configured Claude model.
`open_lead_session` is serialized and idempotent; it returns the existing live attach target or
creates the pane. `stop_lead_session` records the stop before closing the pane. Startup recovery
relaunches a confirmed dead pane from the recipe, resumes a session with a provider-confirmed
transcript, and leaves a missing pane alone until an explicit open. The configured stable MCP port
takes precedence; an instance using ephemeral ports rebinds the saved Main port on restart so an
existing process keeps its endpoint. Main settings are rewritten during recovery to use the current
endpoint. A conflicting listener causes startup to fail rather than silently changing that endpoint.

Main's token selects a separate MCP tool set on the coordinator's existing host: `list_tasks`,
`inspect_task`, `create_task`, `move_task`, `approve_plan`, `reject_plan`, `approve_merge`,
`request_changes`, `answer_question`, `answer_provider_request`, `retry_task`, `cancel_task`, and
`list_repos`, plus `set_note` for its bounded instance memory. Inspection uses the same view as `loom task inspect --json`. Mutations use the CLI's
human-command path and keep every core guard; an input acknowledgement means queued, not approved.
Task-run tokens cannot call these tools, and Main cannot call task-run result tools. Its first
message includes `main-notes` as context and requires a two-sentence introduction followed by waiting.
Work longer than a few seconds becomes a task. The launch denies shell, editing, web and subagent
tools, exposes only Loom MCP plus read-only file tools in the instance directory, and grants no
terminal attach capability to Main. The human can still attach to Main through this panel. The task model, core stages and reconciler are unchanged.

## Performance

The Workbench inherits the shell's budgets and harness: keystroke to glyph p95 ≤ 16 ms, 120 fps
scrolling, view switch ≤ 50 ms, cold start ≤ 1.5 s, idle CPU ≤ 3% with six terminals open. A new
window must open in under 300 ms from an already-running coordinator.

## Out of v1

Editing code, drag-and-drop between windows, a third mode, plugins, themes beyond dark and light.

### Workbench terminals and agent status

Workbench restores a viewer of an existing live terminal from native inventory on open. It never
creates a shell during mounting or navigation. New Terminal and Split name and create a native
shell before mounting a viewer with its exact identity. Closing a terminal ends that pane; native
exit and close updates remove all its views. Dead panes retained by the host remain dimmed in the tree.
Closing the last terminal leaves an empty Workbench with a New terminal action. Selecting an existing row never opens a naming modal.
The standalone `loom-workbench` session has no task or provider run; tmux owns it, and no spare
shell is launched to hold the session open.

The sidebar uses the space → tab → pane tree described above. Recorded agent status appears on
its pane row and rolls up to its ancestors, with no duplicate agent list. Headless runs and task
history without native panes are excluded. A quiet or disconnected terminal is never proof of
completion. Clicking a pane attaches in Workbench without switching to Tracker.

New Tab (including the prefix shortcut) asks for a terminal name in a modal before creating a
shell. Cancel creates nothing. Names are stored as native tmux window names and survive viewer
reconnects; the tab and terminal tree show the name. Provider-confirmed completed turns can show a
finished-turn icon while the agent terminal stays open. Idle and unknown status remain distinct.


### Pinned terminal navigation

Main and Operator stay pinned below the scrollable space tree. Main attaches the existing `lead`
identity; Operator attaches its interactive session, with the same durable queue and policy
checks as before. Both reuse their pinned tabs. Their Hide agent view button only detaches the viewer;
stopping an agent uses its existing agent/task controls. Opening a workspace reserves its tmux
session name without creating a shell; a session is created only when a real agent or explicitly
requested human terminal needs a pane. The brief bootstrap process used while setting its environment
is removed before launch returns, leaving no spare terminal.

### Automatic task terminal

Task detail's Terminal tab has no run dropdown. It opens a live recorded agent terminal immediately;
multiple live runs retain their own tabs and attached clients. With no live terminal, it opens
a reusable human shell in the task's worktree. With no surviving worktree, it opens at the
project root and shows that checkout's actual branch without changing it. Historical run selection
cannot override this task-scoped resolution. Run identity changes re-resolve the target; routine
activity updates do not remount the terminal. Missing host observations surface a retryable error.
