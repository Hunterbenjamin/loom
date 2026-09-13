# Brief: Workbench v2 (Herdr-shaped, on tmux)

Read `AGENTS.md`, `docs/design/ui.md` (Windows, Workbench, Pane host), `docs/briefs/workbench.md`
(v1, what exists) and `apps/desktop/README.md` first. This brief is split into slices; each slice
is one PR, and a slice says which earlier slices it needs.

## Decision

The Workbench stays Loom's own React window on top of the tmux pane host. It is *shaped* like
Herdr because Herdr's hierarchy is the right one, and it maps one-to-one onto tmux:

| Workbench | tmux (`-L loom-<instance>`) | who owns the fact |
|---|---|---|
| Space | session | pane host (name), coordinator (task link, branch) |
| Tab | window | pane host |
| Pane | pane | pane host (process, cwd, dead), coordinator (run, status, attention) |
| Process / agent | `pane_current_command` + the run the coordinator recorded for that pane | provider (status), coordinator (attention) |

We do not adopt Herdr itself. Spikes 03, 05 and 06 measured why: one attach client per pane, a
restore that relaunches agents with canonical commands (dropping `--settings`, `--model`,
`--remote`), agent detection that duplicates and can disagree with Loom's, and worse echo latency
than tmux. Embedding the Herdr TUI in the window would bring all of that back and would sever the
row-to-task links the Tracker relies on.

## The sidebar

```
  Spaces                                      ⌕ filter…
  ▾ ● loom-t-3f2a  Fix delivery race    fix/delivery-receipt-race
      ▾ implementer                                     tab
          ● codex · working                            pane
          ○ zsh                                        pane
      ▸ reviewer                                       tab
  ▾ ◐ interactive-roles                feat/interactive-roles
      ▾ agent
          ◐ codex · needs you: permission
  ▸ ✓ workbench-drag                   fix/workbench-window-drag
  ▸ ○ scratch                          main
  ─────────────────────────────────
  ⌁ Main      idle
```

- **Rows.** A space row shows: the indicator, the space name, and its git branch. A tab row shows
  the indicator and the tab name. A pane row shows the indicator, the process (or the agent's
  role · provider) and the agent's state label. Task spaces show the task key and title; the
  branch comes from the task. Unlinked spaces show their session name; their branch is read from
  the session's start cwd.
- **Indicator** (left of every row, same glyph set as `apps/desktop/src/renderer/workbench/agents.ts`
  today): `◌` working, `◐` blocked / needs you, `✓` done (finished turn or ended), `○` idle, `!`
  failed, `?` unknown. A tab's indicator is the worst of its panes; a space's is the worst of its
  tabs, where the order is needs-you > failed > unknown > working > done > idle. Never derived
  from screen content; only from the run status and attention the coordinator publishes.
- **Rename.** Spaces and tabs are renamed inline (double-click or `F2`, Enter to commit, Esc to
  cancel) and through two new protocol commands, `rename_space` and `rename_tab`, which the
  coordinator executes on the pane host (`rename-session`, `rename-window`). tmux owns the name;
  the UI shows the new name when the next `panes` patch arrives, not optimistically. Task spaces
  keep the task title as their label but their session name may still be renamed. Automatic
  window renaming stays off, as the pane host config already sets.
- **Branch.** The coordinator adds `branch` to the `panes` view: for a linked pane, the task's
  branch; otherwise `git rev-parse --abbrev-ref HEAD` in the pane's start cwd, cached per cwd and
  refreshed on the same schedule as the view. Unavailable is shown as `—`, never guessed.
- **Selection.** Clicking a pane row opens it in the focused panel; Enter opens it in a new tab.
  Clicking a tab row opens all of its panes as a split in a new Workbench tab. Clicking a space
  row expands or collapses it. `g` (after the prefix) still fuzzy-jumps by name.
- **Sound.** When a pane's state crosses into *needs you* or *done* (working → blocked, working →
  finished, starting → blocked), the window plays one short chime and the row flashes once. One
  chime per transition, never per patch; no chime when that pane is the focused panel of the
  focused window; a per-window mute in the bottom bar and a setting in the palette. The transition
  is detected in the renderer store from consecutive `panes` snapshots, so it needs no new
  coordinator event. The chime is a bundled short sound file played through an `Audio` element;
  respect the system's reduced-motion and mute settings.
- **Pinned.** Main stays pinned at the bottom of the sidebar, as today.

## Slices

1. **Tree and indicators** (no prerequisites). Replace the flat terminal list with the
   space → tab → pane tree above, using the fields the `panes` view already carries
   (`sessionName`, `windowId`, `windowName`, `paneId`, `command`, `role`, `provider`, `status`,
   `attention`, `taskLabel`). Rollup indicators. Expand/collapse state per window, in memory.
   Selection behaviour above. Tests: tree selectors (grouping, ordering, rollup, filter) and a
   render test for one linked and one unlinked space.
2. **Branch** (no prerequisites). `branch` on the `panes` view, coordinator-side, with the cache
   and the task shortcut; sidebar shows it on space rows. Tests: view assembly with the fake git
   adapter for linked, unlinked and unreadable cwds.
3. **Rename** (needs 1). `rename_space` and `rename_tab` protocol commands, coordinator executor
   mapping, `PaneHost.renameSession` / `renameWindow` in the tmux adapter with contract tests on a
   `loom-test-<pid>` server, and the inline editor in the sidebar. Validation: tmux session names
   may not contain `.` or `:`; reject at the boundary with zod and show the reason.
4. **Sound and flash** (needs 1). Transition detection in the store, the chime, the flash, the
   mute. Tests: the transition detector with sequences of snapshots (no double chime on a repeated
   patch, no chime on working → working, chime on working → blocked and working → finished).
5. **Tab rows open as splits; per-tab context menu** (needs 1). Right-click on a row: open, open in
   new tab, rename, copy attach command, close panel (never kills the process).

## Rules

- Performance budgets in `docs/design/ui.md` hold; a `panes` patch must not re-render terminals.
- No durable state in the renderer (principle 5). Expand/collapse, mute and layout are per window,
  in memory. Names live in tmux; branches live in git; status lives with the provider.
- Never read or type into panes outside the instance's private tmux server; tests use a
  `loom-test-<pid>` socket and the fake pane host.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` and the desktop build green. Update
  `docs/design/ui.md` where the implementation diverged from it, in the same PR.
