# UI design

Terminology: an “issue” in the UI is a “task” in the code; internal identifiers and MCP tool names retain `task`.

Each window switches between Tracker and Workbench on the same coordinator.
This note describes the first terminal Workbench slice.

## Modes

| Mode | Use | Input | Status |
|---|---|---|---|
| **Tracker** | Issues, the Needs-you inbox, git and PR state, plan approval, diff review | Mouse-friendly, Linear-like density; keyboard for everything too | Live and fixture shell |
| **Workbench** | Where the human talks to agents: a keyboard-first multiplexer with an issue-aware sidebar, tabs and split panes | Keyboard first, tmux-style prefix bindings | Terminal slice |

A **Code** panel (file tree plus a read-only viewer) lives inside the Workbench as a panel type, not a
third mode. Agents write; the human reads and reviews. Editing is out of v1.

## Windows

Every window has its own coordinator connection. Command+Shift+W and the bottom-bar mode button
switch that same window between Tracker and Workbench; the button names the destination mode.
The palette provides the same switch and explicit New Window commands remain separate.

Both modes share the window's issue store. Tracker selection and Workbench tabs/splits survive a
round trip. Inactive mode effects are suspended: terminal viewers detach while hidden and attach
again when shown, without stopping their native panes or agents. No hidden spare window is created.
Closing a window closes only its viewers; the coordinator owns durable issue state.

## Tracker

The top-left picker opens exactly one registered repository; there is no All repositories option.
Every Tracker view, list, board, search and attention count is scoped to that project. Selection
is coordinator-owned: `select_repo({repoId})` persists the per-instance last-opened repository in
SQLite and publishes the `project` row in snapshots and patches to all windows. A new window opens
on that selection; the first registered repository is the initial default, including single-repo
instances. With none, Tracker shows **Open repository**.

**Add repository…** opens Electron's native folder chooser. The main process reads the folder's
Git root and origin, derives GitHub owner/name, and the renderer sends `add_repo({root, github})`.
Registration shares the CLI's defaults and canonical root handling, selects the added repository,
and publishes it to all windows. Cancel creates nothing; chooser, Git and command errors stay inline.

Create issue opens from `C`, the command palette, or **+** beside the repository picker. A native
modal keeps keyboard focus inside it and autofocuses the required title. The Markdown description
grows with its content; Command+Enter submits. Repository defaults to the selected project. Status offers Backlog and Todo (starts the workflow); size offers
Normal and Small (skips planning, for one-file fixes), alongside Require plan approval.

The live window sends `create_task` and waits for its assigned key. Todo then sends a separate
human move; its acknowledgement means queued. Errors remain inline with the draft; a failed move
can be retried without recreating the issue. Success closes the modal, reveals and selects the new
issue in the list, and toasts its key. Escape and Cancel confirm before discarding edited drafts.
Only fixture mode edits the local snapshot.

## Tracker list

Stage headers are buttons: click or press Enter/Space to collapse or expand them. Each header
always shows the total matching issue count. Done and Canceled start with the 20 most recently
transitioned issues, ordered by `stageEnteredAt` descending; Load N more reveals the next 20 (or
the remaining count). Other stages remain unlimited and follow the selected column sort.
Collapse and loaded-page settings stay in each window's memory, including across view switches;
new windows start expanded with the initial limit. Keyboard issue navigation skips collapsed and
unloaded rows. Issue summaries, model labels and progress indicators remain visible per row.

## Workbench

- **Sidebar:** a 260 px panel using Loom's theme colors and normal sans-serif typography,
  with spaces above agents. The tree has exactly two levels: space and tab (tmux window).
  Space names use normal weight with a dim Git branch on the next line. Tabs are indented,
  with a one-character status indicator on each row. Panes and process names are never tree rows.
  Selection highlights the open space and active tab. Spaces occupy up to half of the sidebar;
  both sections scroll independently. The filter, new/menu actions, collapse control and grouped
  agent ordering remain available. Main and Operator stay pinned above the agents list.
  Agents show space and tab, then provider; recorded run identity owns their status.
  Space disclosure controls collapse its tabs; filtering reveals matches without changing saved
  expansion. Double-click or F2 renames a space or tab using the native inline editor.
- **Space view:** the right panel shows exactly one selected space at a time. Its tab bar is that
  space's tmux windows in native window-index order. Clicking a space activates its first tab;
  clicking a tab or agent opens its space with that window active. Each window shows its live
  panes as splits, following the native horizontal/vertical layout and proportions as closely as
  Dockview permits. Each terminal client keeps the full native window size and crops/scales its
  screen to that pane's native cell rectangle, so sibling output and borders are not duplicated.
  Filtering never removes panes from the selected window. Selecting another
  space replaces the right panel; there are no free-floating or mixed-space viewer tabs.
  Right-click or Shift+F10 offers Open/Open space, Copy attach command and Close panel. Copy uses
  the coordinator's quoted attach argv for the first live pane. Close panel only detaches viewers,
  including human shells, and never stops a native pane. It remains available during outages.
  Rename is available inline; its menu entry remains unavailable.
- **Branch:** space rows show the coordinator's `panes.branch`: the linked issue's branch, or Git's
  `rev-parse --abbrev-ref HEAD` at the first native pane's start cwd for an unlinked space.
  Reads are cached per cwd within each serialized inventory refresh, including failures, and
  refreshed on the same hints and poll as the view. Detached checkouts show `HEAD`; unreadable
  paths show `—`. Branch patches update sidebar metadata without remounting terminal viewers.
- **Indicators:** small text glyphs without borders: ○ idle, ● blocked/needs you in the attention
  color, ✓ finished turn/ended, ! failed in the error color, and ? unknown. Working cycles
  through ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ every 80 ms on one shared renderer interval for all
  visible working indicators, including rollups and pinned rows. The clock stops when the
  document is hidden or no working indicators remain. Reduced motion uses static ◌ and no
  interval. Working uses the accent color, finished uses green, and unknown uses violet. Tabs and spaces roll up needs-you > failed > unknown > working >
  done > idle across all descendants, including ones hidden by filtering. Only published provider
  status and coordinator attention determine indicators; native process exit alone is not agent
  completion. Branch display and inline rename follow their separate Workbench v2 slices.
- **Sound and flash:** the window store compares consecutive pane observations using the same
  indicators (including recorded completed turns). Entering needs-you or done plays one bundled
  320 ms chime and flashes each visible occurrence of the pane row once for 600 ms. Repeated patches, initial
  discovery and recovery from an unavailable observation are silent. The focused pane in the
  focused window is silent; background panes still chime. Sound uses ordinary HTML audio and
  respects system output mute/volume. Reduced motion disables the flash. The bottom bar's Sound
  toggle and both palettes' Mute/Unmute transition sounds command share per-window, memory-only
  mute state across mode switches. Muting also stops a chime already playing. The window listens
  in both modes; hidden rows do not replay flashes when revealed. No terminal render or attach
  lifecycle changes are needed for either feedback effect.
- **Tabs and splits:** each native window owns a Dockview Gridview. New tab names and creates a
  scratch-shell window in the selected native space. Split names and creates a scratch pane in the
  active native window, to the right or below the focused pane. With no selected space, New terminal
  opens the standalone Workbench space. Creation goes through the idempotent scratch-shell path,
  with a generation-scoped native target. Stale targets fail rather than creating another space.
  Terminal mounts remain stable over grid cells during resizing, metadata updates, tab switching
  and zoom. Layout is a disposable projection of tmux metadata; no layout is stored in the UI.
- **Panel types in this slice:** native terminal panes, including agents and issue scratch shells.
  Plan, diff, activity and code panels are deferred; Tracker retains its existing review surface.
- **Bindings:** coordinator Settings owns the full binding map, prefix and timeout. On upgrade the
  renderer imports `<LOOM_DATA_ROOT>/<instance>/keybindings.json` once only when no stored binding
  fields exist. Main receives validated updates over IPC for native shortcut suppression and keeps
  a private derived startup cache; editing the legacy file after import has no effect.
  First launch writes the complete defaults. Zod validates the whole file; invalid JSON,
  unknown/missing actions, invalid chords, duplicate bindings or an invalid timeout activate
  defaults and show an error in the Workbench bottom bar. Saving a valid file updates every
  open window, including its shortcut map and palette. This file is user configuration;
  it stores no layout or issue state.
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
  kills only that client. Close panel only detaches the viewer. Electron keys resources by webContents and panel/client identity,
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

- a snapshot plus patches to N clients, with per-client subscriptions so a window showing one issue
  isn't sent every diff of every issue;
- attention with a `since` **per reason**, so the inbox and the sidebar can sort by how long each
  thing has waited (the fixture shell found the single `since` ambiguous);
- for every run, its attach target and its pane-host state (attached clients, exited);
- a changed-files model per issue: path, previous path, status, binary, counts, stable file ID and a
  monotonic version, taken from Git metadata, since Pierre ignores a file whose version didn't change;
- comment threads on findings, review-shell state (viewed files, drafts, current file), and the
  review range (whole branch versus since the last round), all coordinator-owned so they survive a
  window closing;
- an exported attention derivation in `packages/core`, so the UI never re-implements the rule.

## Main

Every window has a 34px bottom bar: connection state and instance on the left, and a Main toggle
with the number of Needs-you rows on the right. The bar also shows the selected repository's
*Ready to merge* PR count (see slice 5 below). `⌘J` opens or closes Main, including while typing
in its terminal. The panel overlays the lower third of the window. Its top edge supports pointer
and arrow-key resizing; height and visibility live only in that window's memory. Closing detaches
that terminal client and leaves the session running. Reopening attaches again and, if native status is idle with no pending dialog, requests a short
Needs-you summary. The palette command **Open Main** opens the same panel. Toggle and resize
state belong to the bar component, so neither updates the issue store nor re-renders the issue list.
The terminal module loads only when first opened, preserving the cold-start path.

Switching projects retargets an open panel to that repository's Main, opening it lazily on first use.
Only the viewer detaches; the other repository's session continues. Attach targets carry `repoId`.

The header shows working, idle or waiting from the coordinator's `claude agents --json` observation.
An absent or unavailable provider observation is unknown, never inferred from terminal output.
Restart stops the session, revokes its token and opens a fresh session through the same attach flow.
Fixture mode previews the bar and terminal without contacting a coordinator or launching an agent.

Main is one interactive Claude session per repository, not an issue run. The coordinator persists its
session ID, private token, launch recipe and per-session settings under `<instance data>/lead/<repoId>/`
before launching at the repository root. Its pane workspace is `lead-<repoId>` (`loom-lead-<repoId>`
on the instance's private tmux server). `LOOM_MODEL_LEAD` overrides the configured Claude model.
`open_lead_session({repoId})` is serialized and idempotent; it returns the existing live attach target or
creates the pane. `stop_lead_session({repoId})` records the stop before closing the pane. Startup recovery
relaunches a confirmed dead pane from the recipe, resumes a session with a provider-confirmed
transcript, and leaves a missing pane alone until an explicit open. The configured stable MCP port
takes precedence; an instance using ephemeral ports rebinds the saved Main port on restart so an
existing process keeps its endpoint. Main settings are rewritten during recovery to use the current
endpoint. A conflicting listener causes startup to fail rather than silently changing that endpoint.

Startup recovery applies the same live/dead/absent/stopped rules to every saved per-repository Main.
An existing single `lead/recipe.json` migrates once to the first registered repository, preserving its
session ID and token and copying settings and notes. The atomic destination recipe makes retry
idempotent. A recorded legacy pane is retired before relaunch in the repository workspace; no
unrecorded pane is adopted or stopped.

Main's token binds every tool call to its repository: task lists and repository lists are filtered,
`create_task` defaults to it, and inspections, dependencies and mutations reject foreign task IDs.
Its first introduction names the repository. Main's token selects a separate MCP tool set on the coordinator's existing host: `list_tasks`,
`inspect_task`, `create_task`, `move_task`, `approve_plan`, `reject_plan`, `approve_merge`,
`request_changes`, `answer_question`, `answer_provider_request`, `retry_task`, `cancel_task`, and
`list_repos`, plus `set_note` for its bounded repository memory. Inspection uses the same view as `loom issue inspect --json`. Mutations use the CLI's
human-command path and keep every core guard; an input acknowledgement means queued, not approved.
Issue-run tokens cannot call these tools, and Main cannot call issue-run result tools. Its first
message includes `main-notes` as context and requires a two-sentence introduction followed by waiting.
Work longer than a few seconds becomes an issue. The launch denies shell, editing, web and subagent
tools, exposes only Loom MCP plus read-only file tools in the repository, and grants no
terminal attach capability to Main. The human can still attach to Main through this panel. The issue model, core stages and reconciler are unchanged.

## Performance

The Workbench inherits the shell's budgets and harness: keystroke to glyph p95 ≤ 16 ms, 120 fps
scrolling, view switch ≤ 50 ms, cold start ≤ 1.5 s, idle CPU ≤ 3% with six terminals open. A new
window must open in under 300 ms from an already-running coordinator.

## Out of v1

Editing code, drag-and-drop between windows, a third mode, plugins, themes beyond dark and light.

### Workbench terminals and agent status

Workbench restores a view of an existing native space on open. Mounting and navigation never
create shells. Native exits remove their viewers; dead panes remain represented only in tab/space
rollups and the agents list. Closing a panel detaches it and leaves the native window in the tab bar;
selecting the sidebar row reopens its viewers. The standalone `loom-workbench` session has no issue
or provider run and never launches a spare shell to hold the session open.

The sidebar has a space → tab tree and a separate agents list. Only recorded provider status and
coordinator attention determine status. Headless runs and issue history without native panes are
excluded. A quiet or disconnected terminal is never proof of completion.

New Tab (including the prefix shortcut) asks for a terminal name in a modal before creating a
shell. Cancel creates nothing. Names are stored as native tmux window names and survive viewer
reconnects; the tab and terminal tree show the name. Provider-confirmed completed turns can show a
finished-turn icon while the agent terminal stays open. Idle and unknown status remain distinct.


### Pinned terminal navigation

Main and Operator stay pinned below the scrollable space tree. Main attaches the selected repository's `lead` identity; Operator attaches its interactive session, with the same durable queue and policy
checks as before. Both open their native space and windows in the right panel. Close panel only detaches the viewer;
stopping an agent uses its existing agent/issue controls. Opening a workspace reserves its tmux
session name without creating a shell; a session is created only when a real agent or explicitly
requested human terminal needs a pane. The brief bootstrap process used while setting its environment
is removed before launch returns, leaving no spare terminal.

### Automatic issue terminal

Issue detail's Terminal tab has no run dropdown. It opens a live recorded agent terminal immediately;
multiple live runs retain their own tabs and attached clients. With no live terminal, it opens
a reusable human shell in the issue's worktree. With no surviving worktree, it opens at the
project root and shows that checkout's actual branch without changing it. Historical run selection
cannot override this issue-scoped resolution. Run identity changes re-resolve the target; routine
activity updates do not remount the terminal. Missing host observations surface a retryable error.

### Renaming spaces and tabs

Double-click a space or tab row, or focus it and press F2, to edit its native name inline.
Enter submits; Escape cancels. Space names cannot contain `.` or `:`; empty names and control
characters are rejected, with the reason displayed beside the editor. Task spaces retain their
task title as the label while the editor and row tooltip expose the native session name.
The coordinator executes `rename_space` / `rename_tab` against generation-scoped native session
and window IDs. Labels change only with the next `panes` patch. Tab automatic renaming stays off.
Native pane identity keeps open viewers mounted across renames; reconnect resolves the current
name. A tmux session option retains its original workspace key, preserving task links and later
scratch/run creation across coordinator restarts. Main and Operator retain their pinned identities.

## Pull request protocol (slice 2)

The coordinator now exposes `pullRequests` in snapshots and `pull_request` collection patches.
Rows contain GitHub's list fields and read time, the registered `repoId`, and a nullable `taskId`
when exactly one issue in that repository has the head branch. Off-pipeline PRs need no issue.
Keys are `JSON.stringify([repoId, number])`.

A window subscribes to `{kind: "pull_requests", repoId, state}` to load and poll a repository
list; `state` defaults to `open` and also accepts `merged` or `closed`. Subscribers receive all
cached states for their repository, including a row that just left their selected state; the
window applies its own state and text filters. `{kind: "pull_request", repoId, number}` adds
`pullRequestDetails` / `pull_request_detail`, containing detail and the capped unified patch with
its truncation flag. Detail and patches only reach windows with that exact subscription.
Closing or changing a view removes its subscription. The last window leaving cancels its poll;
reopening refreshes the owner. Lists poll every 60 seconds and detail every 30 seconds, shared
across windows with the same scope. These projections are disposable; reconnects rebuild them
from GitHub and issue links from the coordinator store.

Commands name a registered `repoId`: `merge_pull_request` also carries `number`, `matchHeadSha`
and `deleteBranch`; `close_pull_request` and `delete_branch` carry `number`; and
`refresh_pull_requests` carries `state` (default `open`). Standalone deletion resolves the branch
from the PR and refuses an open PR or base branch. Each command returns one ack, with refreshed
projections on success and a typed error on refusal. The executor checks the fresh head, open and
non-draft state, mergeability and CI before a squash merge, without auto-merge or an override.
No checks is allowed; pending or failed checks are refused. Already merged and already absent
branches are idempotent. Actions and failures both trigger owner refreshes; uncertain writes
are never replayed automatically. Linked issues only change stage through normal reconciliation.

This slice adds no sidebar, list/detail components, confirmations, shortcuts or notifications.
The existing desktop fixture merely supplies empty collections for the extended protocol.


## Reviews list (Reviews slice 2)

Tracker's **Reviews** entry replaces Pull requests. Its count includes open PRs ready to merge,
review requested of the GitHub viewer, and the viewer's PRs with failing checks, conflicts or
changes requested. This count is independent of the selected tab, collapsed sections and search.
GitHub supplies viewer authorship and review-request facts in both list and detail reads.

**For you** groups relevant PRs in this order: Ready to merge (non-draft, mergeable, passing or
no checks, no required or outstanding viewer review and no requested changes); Needs attention
(the viewer's or review-requested PRs with failures, conflicts or changes requested); Waiting
(the viewer's or review-requested PRs with pending checks or review); Created by you (remaining
open PRs authored by the viewer); Completed (merged and closed). **Created** shows only the
viewer's authored PRs under Created by you and Completed. Unrelated failing or pending PRs
are not silently treated as requests for this human. Empty open sections are omitted.

Section bars are collapsible buttons with counts. Completed starts collapsed and sorts by
GitHub completion time, newest first, revealing 20 rows and then Load N more. Open sections
sort by creation time, newest first. Tabs, filter, collapse settings, page size and cursor are
per-window presentation state, retained across view/mode switches. J/K skips collapsed and
unloaded rows; Enter opens the PR. Native buttons also support Enter/Space. / focuses the
compact search control; Escape clears it. Search matches title, number, branches, author and
linked issue key.

Rows follow the Linear reference: green open, purple merged or red closed PR glyph, title,
one trailing status glyph (green check, red cross, amber pending dot, or lightning while a
linked issue has a provider-confirmed working run), and age. No checks leaves the status slot
empty. The linked issue key appears on hover or keyboard focus and opens the issue separately.
No native terminal output or process state determines whether an agent is working.

The selected repository's open scope remains subscribed in both modes for the bottom bar.
Reviews additionally subscribes to merged and closed while visible, using existing shared
60-second polls and cached projections. Switching repository/view or hiding Tracker releases
unused history/detail scopes. Completed pagination limits rendered rows; the existing GitHub
adapter retains its bounded cursor pagination. No durable renderer state or detail-page redesign
is introduced by this slice.


## Pull request detail and actions (slice 4)

Selecting a PR or clicking an issue detail's PR number opens the same in-app detail frame.
The selection is keyed by repository and number, independent of list filters, and subscribes to
that exact PR while Tracker is visible. Closing the detail, opening an issue, or switching
repository/view releases its detail scope. Reconnects replace the disposable projection.

The header shows title, number, state, head → base, author, the last GitHub read time, and
Open on GitHub. Description renders Markdown (including tables and task lists, without raw HTML).
Checks lists every native run with status, conclusion, duration and link. Commits lists messages,
authors, times and linked SHAs. Files reuses the Pierre CodeView and shared worker pool, read-only
with no findings, replies or viewed-state writes. Empty/unparseable patches show an error. Capped
patches announce truncation and omit the final possibly incomplete file; the full diff is on GitHub.
HTTP(S) links open in the system browser, never in a new privileged application window.

Squash and merge stays visible and explains disabled states: missing detail, disconnection, closed
or merged PR, draft, unknown/conflicting mergeability, or pending/failed checks. No checks is allowed,
as in the executor. Confirmation names the displayed head SHA and base, and defaults Delete branch
after merge to checked. A changed head/base invalidates the open confirmation. Close also requires
confirmation. Delete branch is enabled only on merged/closed PRs with an observed existing head
branch, excluding the base branch; unknown existence stays disabled. Branch existence is a disposable
GitHub detail fact, refreshed through the adapter using the actual head repository (including forks).
Refresh and all mutations use existing coordinator commands, with no direct renderer GitHub access.
Pending commands disable duplicate submissions. Outcomes and errors remain inline; merged-at and
branch-deleted labels come from refreshed GitHub observations. No task stage is changed by the UI.


## Pull request polish (slice 5)

With a PR detail open, the Tracker palette includes Squash and merge (`m`), Delete branch (`d`),
Open on GitHub (`o`) and Refresh pull request (`r`). The single-key shortcuts activate the same
controls: merge still opens the exact-head confirmation, and disabled actions cannot run. Typing,
terminals, the palette, native dialogs and modified/repeated keys retain their own input handling.
Palette commands show the same eligibility reasons as the action bar; pending submissions cannot
be duplicated. The existing Pull requests navigation command is also available in the palette.

A merge command submitted from the app produces a native system notification when the coordinator
returns its result after the GitHub refresh, including if the human has navigated away from detail.
Successful results announce the squash merge and requested branch deletion; errors include the
coordinator's reason. A lost response is explicitly unconfirmed and directs the human to refresh,
never to replay automatically. Notification delivery does not alter the command outcome. Merely
observing a merged PR or running a fixture command does not notify.

The bottom bar in both window modes shows *Ready to merge* for the selected repository, regardless
of list state or text filters. It counts cached open, non-draft PRs with positive mergeability and
passing or no checks, using the action bar's eligibility rules. The count is a disposable projection,
not approval or a guarantee against later pushes. Each window subscribes to its selected repository's
open list, including outside the PR view; the coordinator shares the existing 60-second conditional
poll across matching windows and releases it when no window subscribes. Switching repository changes
the scope. Detail and non-open list polls are still released when their views are hidden.

## Reviews loading (slice 1)

The current PR detail layout is unchanged. Description (the overview) becomes readable as soon
as GraphQL detail arrives; Files shows **Loading diff…** until its separately published diff
arrives. A diff failure leaves the overview readable and offers Refresh. New-head detail never
shows an old-head diff. Metadata includes files, reviews and comments, without adding the later
Reviews inbox, Overview rail, activity/comment controls or Reviewed-file cards.

`pull_request_detail.patch` is nullable, with `patchLoading` and `patchError`. A non-null patch
must match both detail SHAs. GitHub's REST diff has no commit identity in its response: Loom
requests an immutable base/head comparison using cached list metadata in parallel with detail.
Opening an uncached PR shows detail first and then requests that range. Head/base and content
caches are disposable and shared across windows; unchanged polls only fetch live metadata/checks.
Content edits, head/base changes and explicit refresh invalidate content. Targets on this repo:
overview under two seconds, diff under four. Later Reviews slices own the layout redesign.

## Reviews Overview (reviews slice 3)

The PR detail frame now follows `linear-reviews-2.png`: one breadcrumb row (issue key or
No issue, title, additions/deletions, pinned star, overflow actions, GitHub chip, fullscreen),
then Overview / Diff and a primary Squash & merge split button. Its menu defaults branch
deletion to on; the existing exact-head confirmation and merge guards remain in force.
Open branch agent navigates to the linked issue's existing interactive agent terminal; it is
disabled when no agent exists. Fullscreen expands the detail within the current window.

Overview has a wide reading column with title, author/base/head, Markdown description,
chronological GitHub activity and a PR comment composer. The right rail contains Status,
Resolves, Reviewers, expandable Checks, Branch and changed files, in that order. Files are
grouped into Implementation and Tests (`*.test.*` or a test/tests/__tests__ directory), with
counts at both levels. Selecting a file opens Diff and scrolls the existing Pierre viewer to
it, including when its patch arrives later. This slice retains the existing read-only Diff
viewer and list; it does not add the later Reviewed cards, inbox grouping or polish shortcuts.

Pin and Link issue commands store coordinator-owned preferences keyed by repository and PR
number. Linking accepts an exact issue key (case insensitive) in the same repository, and the
manual link takes precedence over branch matching in PR projections. It does not rewrite task
branches or stage state; the issue-side PR display enhancement remains reviews slice 5. Both
preferences survive restart and are re-read before publishing. There is no local optimistic pin
or merge state. Comment drafts are transient form input; posting goes through the executor and
GitHub adapter, with a per-submission identifier that makes retrying an uncertain submission
idempotent. Only acknowledged posts clear the draft; owner refresh supplies Activity.

Requested reviewers are read from GitHub alongside reviews. Adding reviewers stays disabled.
Branch divergence uses an immutable base/head comparison, cached by both SHAs, and publishes
independently after Overview; an unavailable comparison never claims Up to date. Conflicts
come from GitHub mergeability. Every GitHub write retains the existing refresh path.

## Reviews Diff (reviews slice 4)

Diff replaces the old Files sidebar with the reference's Files N / Commits N toolbar and
virtualized Pierre file cards. Files follow the Overview rail's Implementation, then Tests order.
Each header shows name, directory, additions/deletions, Reviewed, and a copy-path/GitHub menu.
Unified is the default; settings offer split and Hide whitespace changes. Syntax colors, line
numbers and expandable unchanged-line separators use Pierre and the existing bounded worker pool.
Full contents load on demand through the coordinator; whitespace patches are computed in the
GitHub adapter, outside the renderer. Unavailable, binary, oversized and incomplete patches are
explicit, never a clean review. File contents are capped at 2 MiB per side and patch reads at 8 MiB.

Reviewed marks use `save_review_state` with repository/PR identity and the viewed-file contract.
SQLite owns them at the PR head SHA; updates publish to every subscribed window, survive closing
and reopening, and a different head shows no marks. An acknowledgement alone never checks a box.
Marking Reviewed collapses that card; clearing it expands the card. Commits lists message, author
and age; selecting a commit fetches its first-parent diff. Reviewed is disabled for a commit-only
view because it cannot certify the complete PR. Files returns to the whole PR. `j`/`k` selects the
next/previous file, `v` toggles Reviewed, and `[`/`]` jumps between the selected file's hunks.
Typing, dialogs, the palette and modified key chords keep their existing bindings.

## Reviews polish (reviews slice 5)

Command+Enter opens the same exact-head Squash & merge confirmation anywhere on the PR page,
including the Overview comment/link inputs and Diff. It never submits a comment or bypasses
confirmation. Existing merge guards, pending submissions and head/base invalidation still apply.
Dialogs, the palette, terminals, composition and repeated or additional modified chords retain
control of their input. The existing single-key and palette actions remain available.

Link issue publishes both directions from the coordinator's one saved PR-to-issue relation.
Issue detail shows these PR buttons alongside its observed branch PR, without duplicates;
multiple explicit references are retained. The reverse links travel in task inbox metadata,
so opening an issue after restart requires no Reviews list subscription or GitHub read. Relinking
removes the old issue's reference and updates the new one. It does not rewrite the issue's branch,
workflow PR identity, stage or approval.

A newly observed merged PR in either a list or detail triggers an immediate fresh observation
of matching task branches in that repository. Normal reconciliation then derives Done from GitHub;
a manual reference to a different issue does not complete that issue. In-flight observations from
before the hint cannot refill the invalidated PR cache. This also covers merges made on GitHub
and uncertain app merge responses; neither a command acknowledgement nor a renderer patch sets Done.

Fixture Reviews cover all five list sections, both tabs, more than one page of completed PRs,
linked/working and unlinked branches, checks/reviews/comments/merge activity, branch divergence,
Implementation and Tests file groups, and pinned/Reviewed examples. Fixture actions remain read-only.
