# Recorded tmux output

Trimmed real output from tmux 3.7c on macOS 26.2, captured with the same formats the adapter
sends. Paths were rewritten to `/Users/example/...`; nothing else was changed.

- `list-panes.txt` — `list-panes -a -F <PANE_FORMAT>` with the monitor session, a task's shell
  window, two run panes (one dead, exit 7) and the same panes seen again through an attached
  grouped view session. Fields are separated by US (0x1f).
- `list-clients.txt` — `list-clients -F …` with two clients on one run's view and one on another.
- `show-environment.txt` — `show-environment -g` right after the server was created from an
  allowlisted client environment, plus the `-NAME` removal markers `set-environment -r` writes.
- `control-mode.txt` — the notification stream a control-mode client sees while a pane dies.
