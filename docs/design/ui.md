# UI

The desktop has two modes on the same coordinator: **Tracker** for issues and reviews, and
**Workbench** for native terminal spaces. Each window has its own connection and transient views.
[Architecture](../architecture.md) defines ownership; [desktop README](../../apps/desktop/README.md)
contains running instructions and source entry points.

## Windows and repository selection

Cmd+Shift+W, the bottom bar and the palette switch the current window's mode. Tracker selection and
Workbench selection survive the round trip; hidden terminal clients detach without stopping panes.
Explicit New Window commands open independent viewers. Closing a window detaches its clients.

The repository picker selects one registered repository. Selection is coordinator-owned and
published to all windows. Add repository uses a native folder chooser, resolves the Git root/origin
and registers it through the coordinator. No repositories produces an Open repository state.
Tracker lists, board, search, review lists and counts follow the selected project.

## Issues and Inbox

Create issue opens with `C`, the palette or the picker's plus button. It offers Backlog/Todo,
Normal/Small and plan-approval policy. Cmd+Enter submits; edited drafts require confirmation before
discard. Creation waits for the assigned issue key; Todo then sends a separate move, so a failed
move can be retried without duplicating the issue.

List stage headers collapse groups. Done/Canceled initially show the latest 20 by stage-entry time
and load more on demand. Other stages follow the selected sort. Collapsed and unloaded rows are
excluded from keyboard navigation; these display choices stay in window memory.

Needs you shows one row per issue/attention reason, oldest first, with core-supplied run attribution.
Enter opens the resolving issue detail. Multiple runs for a reason can be selected in the decision
panel. A command acknowledgement follows the [core command contract](core.md#instant-human-commands);
commands are not replayed after a disconnect.

`?` opens the [Tracker shortcut map](../../apps/desktop/src/renderer/ui/tracker-help.tsx), which owns
the key list. Shortcuts follow the active list, board or detail and pause in inputs and terminals.
F6 returns focus from terminal input to detail controls.

## Combined issue and PR detail

Issues, Inbox and linked Review rows open the same issue detail. Selecting a linked PR subscribes
to both issue and PR; selecting an issue also subscribes to its primary PR. PR-only details and Daily
brief reuse the common reading-column/property-rail layout.

Issue Overview shows the request and “What changed” from the [implementation artifact](../architecture.md#issue-description-and-implementation-publication), omitting the duplicate GitHub body.

The issue tabs are conditional:

| Tab | Available when |
|---|---|
| Overview | Always: issue content, decisions, activity and properties |
| Plan | A plan exists |
| Diff | A PR or branch exists; see the branch-only limitation below |
| Terminal | The issue has a live native pane |

Branch-only issues render a Diff tab and request `fetch_diff`, but that task command currently
returns `unavailable`. PR-backed diffs work through the repository PR path. The UI reports the
branch request error; it does not imply the branch is clean.

The header and decision panel expose current actions and keep guard errors inline. Backlog editing
changes title, Markdown description, size and plan-approval policy with an expected task version.
Work time appears using the [core transition-derived measure](core.md#findings-evidence-and-work-time).

PR Overview adds Markdown description, chronological GitHub activity and a comment composer. The
rail shows status, issue links, reviewers, checks, branch divergence and files grouped into
Implementation/Tests. Pin and Link issue are persisted preferences. Explicit links may add several
PR references to an issue; they do not change its workflow branch.

Overview becomes readable before its patch arrives. Diff loading/failure leaves the Overview usable;
a new head never displays an old patch. [GitHub projections](../architecture.md#github-projections)
own read freshness, storage and mutation semantics.

### Diff and merge controls

Pierre renders file cards with counts, Reviewed marks, path menus and expandable context. Unified
is the default; split and hide-whitespace options are available. Commits opens a selected commit's
first-parent diff; Reviewed is disabled there because it cannot certify the full PR. Marking a file
Reviewed collapses its card. Unavailable/binary/oversized content is explicit.

`j`/`k` selects files, `v` toggles Reviewed, and `[`/`]` navigates hunks when the diff has keyboard
control. Inputs, dialogs, terminals and the palette retain their input handling.

The Squash & merge control and Cmd+Enter open the same confirmation on PR pages, naming the head.
Issue-owned PRs follow issue approval; unlinked PRs use the guarded direct PR command. Ready-to-merge
counts are disposable eligibility summaries, not approvals or guarantees against a later push.

## Workbench

The sidebar contains spaces and their tabs (tmux windows), plus a separate agents list with Main
pinned. Panes are not a third tree level. Filtering retains saved expansion and does not remove
siblings from the selected native window. Agent rows use recorded provider identity for status.

Selecting a space opens its native windows in index order. Each window's pane layout comes from
tmux; there are no mixed-space viewer tabs. Terminal clients retain the native window dimensions
and crop/scale to their pane rectangle. Metadata patches and theme updates do not remount terminals.

New tab creates a named scratch window in the selected space. Split creates a scratch pane right
or below in its native window. With no space, New terminal uses the standalone Workbench space.
Generation-scoped stale targets fail. Navigation never creates a shell.

Double-click, F2 or Rename edits a native display title; identity is unchanged. Row menus also offer
Open, Copy attach command and scoped Close. **Close kills the native pane/tab/space** through the
coordinator and rejects scopes with live Loom runs; tab/space closes confirm first. Mode switches
and window teardown only detach. The host observation confirms removal.

Indicators roll up attention, failure, unknown, working, done and idle using published provider
state. A process exiting alone does not prove agent completion. Working indicators share one timer
that pauses while hidden and respects reduced motion. New needs-you/done transitions can chime and
flash; initial discovery and recovery are silent, as is the focused pane in the focused window.
The bottom-bar sound toggle and palettes control the window's transient mute.

### Keyboard and terminal input

Settings owns bindings, prefix and timeout; the palette and shortcut help show effective values.
Defaults and the chord grammar live in [core/keybindings.ts](../../packages/core/src/keybindings.ts).
The default prefix is Ctrl+Space, with a three-second timeout. Common suffixes are `|`/`-` to split,
`h j k l` to focus, `c` for a new terminal, `n`/`p` for tabs, `x` to close and `z` to zoom. Repeating
the prefix sends it literally. Escape/blur cancels; unknown suffixes pass through.

Window capture handles shortcuts before xterm; Electron suppresses competing native accelerators
for configured Workbench chords. Naming dialogs and the palette retain their own input handling.
Cmd+J and Cmd+Shift+W are reserved. Legacy binding import is covered in [settings](../architecture.md#settings).

Attach replays host history into viewer scrollback. Selection copies on mouse release; alternate
screen programs receive wheel input themselves. The [pane-host contract](../architecture.md#pane-host-and-embedded-terminals)
explains attach isolation, sizing and native ownership.

## Main

Cmd+J and the bottom-bar Main toggle open a floating conversation window in either mode. It can
minimize, expand or close without changing the provider session. A stopped Main offers Start;
opening chat alone does not start it. The pinned Workbench Main row is the terminal entry point.
Agent menus offer Open as chat against the existing session/thread, alongside its terminal.

Repository switching retargets the viewer. Header status comes from native observations. Restart
stops the old Main, revokes its token and opens a fresh session. Chat reads and sends share the
[conversation contract](../architecture.md#conversation-and-usage); Main's capabilities, notes and
summary behavior live in [agent layers](agents.md#main).

## Daily brief

Daily brief lists recent runs and opens an edition in the shared detail layout. It shows research
items, sources, evidence/limitations and practical next steps. Pause schedule and Run now act through
authenticated commands. The page is a disposable cache: [architecture](../architecture.md#daily-ai-builder-brief)
owns schedule, research limits and interrupted-run behavior.
