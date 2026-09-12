# Spike 06: tmux as the pane host

**Agent:** codex · **Timebox:** about 2 hours, counted from your first experiment. Time spent waiting
for a human's approval doesn't count. Read `spikes/README.md` first, then the findings of spikes 02,
03 and 05, whose harnesses you'll reuse.

## Why

Loom currently uses Herdr as its pane host: the thing that keeps agent PTYs alive, lets the app attach
a view, delivers prompts, and starts processes in a worktree. Herdr's distinguishing feature is agent
awareness, which Loom provides itself and never trusts from Herdr. tmux does the pane-host job with
fewer workarounds: environment control is built in, several clients can attach at once, and it has
no restore feature to get wrong. This spike measures whether tmux meets the same budgets, so the
decision is made on numbers.

## Setup

- tmux from Homebrew if missing (`brew install tmux`). Record the version.
- **Isolation:** every tmux command uses a private server, `tmux -L loom-s06`. Never touch any other
  tmux server. Throwaway repo under `$TMPDIR/loom-spike-06/repo`.
- Agents: a Claude agent (`claude --session-id <uuid> --settings <spike 02's hooks file> --model
  haiku`) and a Codex TUI connected to a private app-server started **outside tmux** (`codex
  app-server --listen unix://…`, as in spike 05), each in its own tmux window created with `-c
  <repo>` and `-e` to scrub `CLAUDE_CODE_*` and `HERDR_*`.
- Spike 02's hook server for delivery confirmation; spike 03's Electron app with its attach command
  changed to `tmux -L loom-s06 attach -t <target>`.

## Questions

1. **Attach in Electron.** With spike 03's harness: keystroke-to-glyph p95 (budget ≤ 16 ms; Herdr
   measured 9 ms in the shell PR), mouse and wheel scroll with `mouse on`, Shift+Enter through the
   kitty shim, and two clients at once (the app and a Ghostty window on the same target) with
   `window-size latest` and `aggressive-resize`. Does typing in one show in the other, and what
   happens to sizes?
2. **Prompt delivery.** Send 100 prompts to the Claude agent via `set-buffer` + `paste-buffer -p`
   (bracketed) + `send-keys Enter`, the same mix as spike 02: short, multi-line, 2 KB, 20 KB,
   special characters, and lines starting with `/` and `!`. Count exactly-once delivery from
   `UserPromptSubmit`. Also prompt while the agent is working and while it's at a permission dialog.
3. **Environment.** Confirm from inside the agent that `-e` removed the scrubbed variables and that
   nothing else leaked from the tmux server's environment.
4. **Exit and restart.** Detect an agent process exiting (`remain-on-exit`, `#{pane_dead}`, and control
   mode's `%exit`). Then `kill-server` with both agents mid-turn and measure recovery from stored IDs
   alone: Claude `--resume <id>` and Codex `resume <thread> --remote <sock>`. Does the Codex turn
   complete through the restart, as it did in spike 05 with the app-server outside the host?
5. **Interrupt.** `send-keys Escape` to each agent; confirm from the provider, not the screen.
6. **Read-only discovery.** After a coordinator restart, can Loom find its agents from `list-panes -F`
   (cwd, pid, command) joined on the worktree path?

## Deliverable

`FINDINGS.md` with:
- the measured numbers side by side with Herdr's from spikes 02, 03 and 05;
- a recommendation, tmux or Herdr, with the reasons;
- a proposed `PaneHost` interface: the current `HerdrAdapter` methods that tmux still needs, the ones
  that become unnecessary, and anything tmux needs that Herdr didn't.
