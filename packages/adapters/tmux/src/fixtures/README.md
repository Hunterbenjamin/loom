# Recorded tmux output

Trimmed real output from tmux 3.7c on macOS 26.2, captured with the same formats the adapter
sends. Paths were rewritten to `/Users/example/...`, and the `@loom_task` column was dropped
when the adapter stopped setting it; nothing else was changed.

- `list-panes-titles.txt` — `list-panes -a -F <PANE_FORMAT>` with the monitor session, a human's shell
  window in a task's session, two run panes (one dead, exit 7) and the same panes seen again
  through an attached grouped view session. Fields are separated by US (0x1f).
- `list-clients.txt` — `list-clients -F …` with two clients on one run's view and one on another.
- `show-environment.txt` — `show-environment -g` right after the server was created from an
  allowlisted client environment, plus the `-NAME` removal markers `set-environment -r` writes.
- `control-mode.txt` — the notification stream a control-mode client sees while a pane dies.
