# `@loom/adapter-tmux`

Loom's `PaneHost`: tmux on a private server, `-L loom-<instance>`, with a private config loaded
before any pane exists. It owns terminal processes and nothing else. It never reports agent
state, never names a provider session, and `pasteText` never means more than "bytes written".

Chosen in [spike 06](../../../spikes/06-tmux-pane-host/FINDINGS.md), which measured tmux against
the budgets Herdr met: 5–6 ms keystroke to glyph, 89 of 89 prompts delivered exactly once, two
clients and Ghostty on one agent at the same time, recovery from a killed server in about 30 s.

## Shape

```
loom-<instance>                    the server; one per Loom instance, never the user's own
├── loom-monitor                   holds the control-mode client; one `sleep` pane, no agents
├── loom-<taskId>                  one session per task = one worktree = one branch
│   ├── <runId>                    one window per run, tagged `@loom_run`
│   ├── scratch-<key>              a shell the human asked for, only ever on request
│   └── …
└── loom-<taskId>-v<n>             a grouped session per attach target (see below)
```

**One session per task, one window per run, and nothing else.** A task's session appears with
the first window Loom opens in it and is gone once the last one is killed; there is no idle
placeholder window. tmux cannot create a session without a window and fixes a pane's
environment when it spawns, so a throwaway `loom-hold` window (a `sleep`) holds the new session
open only while the real window is scrubbed and created, and `listPanes` never reports it.

Clients attached to the same session share its
current window, so two Loom windows on one task would fight over it. `attachArgs` therefore
creates a *grouped* session — `new-session -A -t <task session>` — which shares the window list
but keeps its own selection, and then selects the run's window in it. Measured here: two views
of one task hold two different current windows while the base session keeps its own, and any
number of ordinary clients may attach to the same view. There is no takeover and no eviction.

## What the real tool does

Beyond spike 06's findings, established by this package's tests:

- **`tmux start-server` leaves nothing behind.** The server exits as soon as it has no sessions,
  so the first *session* is what creates the server — and what fixes its environment. The monitor
  session is created from an allowlisted environment for exactly that reason.
- **`-e PATH=…` does not work.** tmux takes a new pane's `PATH` from the *client process* that
  ran `new-window`, and the `-e` value is overridden. Every other name honours `-e`. So the
  adapter runs its tmux client with the pane's `PATH`, and the client environment is part of the
  isolation policy rather than a detail.
- **tmux rewrites non-printable characters in `-F` output unless its locale is UTF-8.** With no
  `LANG`/`LC_*`, the unit separator the pane format uses came back as `_` and every row was
  unparseable. `withUtf8Locale` guarantees one for the client; `parsePanes` drops a row it cannot
  parse rather than guessing at it.
- **tmux does not expand `#{…}` in a hook's own arguments** — `set-hook -g pane-died 'set -g @x
  "#{pane_id}"'` stores the literal text. It *does* expand them in `run-shell`'s command, against
  the pane the hook fired for, which is how the exit hook reports which pane died.
- **`refresh-client -B`'s `%*` covers only the attached session's panes**, so per-pane
  subscriptions cannot watch a whole server. The server-wide signal is a global user option that
  the `pane-died`/`pane-exited` hooks bump, with an empty `what` subscription reading it.
- **`%subscription-changed` is capped at once a second.** Measured end to end: a pane died 136 ms
  after the keystroke that ended it, and the hint reached the coordinator 773 ms after that.
- **`pane_dead` needs `remain-on-exit on`**, which the private config sets. `pane_current_path`
  empties when the process goes; `pane_start_path` survives, and is the task join key.

## Rules this package keeps

- **No decision from terminal text.** Nothing here reads a screen. `PaneObservation` carries only
  native facts: pid, command name, dead, exit status, start path.
- **`pasteText` returns `"written"`.** In spike 06 a paste into a pending permission dialog
  *approved the command* instead of delivering a prompt. The coordinator must gate every send on
  the provider's status and confirm delivery from the provider's channel; the host cannot.
  A leading `/` or `!` is refused outright, since both TUIs read it as a command.
- **Pane refs are scoped to a host generation** (`loom-<instance>#<server pid>`). tmux restarts
  pane IDs at `%0` after a server death, so a ref from an older generation resolves to nothing
  even when a pane with that ID exists again.
- **The environment is an allowlist.** `-e` adds; only `set-environment -r` removes; the client
  environment decides `PATH`; `update-environment` is empty so attaching adds nothing.
- **Loom only touches panes it started.** Mutations require a `@loom_run` tag on the pane.

## Using it

```ts
const host = createTmuxPaneHost({
  instance: process.env.LOOM_INSTANCE ?? "dev",
  configPath: "/Users/you/.loom/dev/tmux.conf",
  // Absolute: the client runs with an allowlisted PATH that may not contain tmux.
  tmuxExecutable: "/opt/homebrew/bin/tmux",
});
```

## Tests

`pnpm test` runs them against a throwaway server of their own, `-L loom-test-<pid>`, killed
afterwards; they never name another socket and never start an agent. They are skipped when tmux
is not installed. Real-provider probes stay in spike 06 and are not run from here.

Workbench inventory includes session ID, window name and pane title as native metadata. It excludes
the monitor and grouped view aliases, and retains dead panes. `listClients` counts clients in the
canonical session group, not exact pane-focused viewers. `createScratch` uses its own UUID key,
existing session, executable argv and allowlisted environment without minting a run.

Attach clients on tmux 3.7c use `active-pane`. Selecting the next pane then the requested pane after
attach initializes client-local pane selection even when the requested pane was already globally
active (tmux otherwise returns early). The owned PTY integration test verifies two sibling shells
receive distinct input and survive a viewer detaching. Tests require Python 3 for this PTY bridge;
they never read or type into existing user panes.
