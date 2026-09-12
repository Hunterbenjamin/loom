# Spike 05: Restart and recovery (rerun)

**Agent:** claude · **Timebox:** about 90 minutes, counted from your first experiment. Time spent
waiting for a human's approval doesn't count. · **Depends on:** spikes 01 and 02, both merged. Read
`spikes/README.md` first.

## Why

Loom promises that nothing is lost when something restarts. Spikes 01 and 02 already answered the
provider side:
- **Codex:** a turn survives its last client disconnecting. After an app-server crash, the history comes
  back with the unfinished turn marked interrupted
  ([spike 01](../01-codex-shared-thread/FINDINGS.md), sections 4 and 5).
- **Claude:** after the process is killed, `claude --resume <id>` restores the same session, but the
  in-flight tool call is lost ([spike 02](../02-claude-hooks/FINDINGS.md), section 5).

What's still unknown is Herdr's side: what happens to the agents in its panes when the Herdr server
stops, restarts or is killed. This spike measures that.

The first attempt ran out of time waiting for an approval and tested nothing (PR #6, closed). What it
learned is folded into the setup below.

## Setup

- **Isolation:** run everything in a separate named Herdr session, `loom-s05`. Never stop, restart or kill
  the user's main Herdr server.
  - Start it headless: `HERDR_CONFIG_PATH=$TMPDIR/loom-spike-05/herdr/config.toml herdr --session loom-s05 server`.
  - Its state lives in `~/.config/herdr/sessions/loom-s05/`. `HERDR_CONFIG_PATH` only chooses the
    config file.
  - Point CLI calls at it with `HERDR_SOCKET_PATH=$HOME/.config/herdr/sessions/loom-s05/herdr.sock`, as
    spike 03 did.
  - Start the server without `HERDR_*` or `CLAUDE_CODE_*` variables. Spike 03 found that an inherited
    `CLAUDE_CODE_CHILD_SESSION` turns off transcript saving.
- **Agents:** in a throwaway git repo under `$TMPDIR/loom-spike-05/repo`, start these in that session:
  - a Claude agent with `--session-id <uuid> --model haiku`;
  - a Codex TUI connected to a private app-server (`codex app-server --listen unix://…`, as in
    spike 01). Say whether the app-server runs in a pane of the session or outside Herdr.
- **Before every trial,** record each agent's pane ID, PID, provider session or thread ID, and state.

## Questions

Test each fault with the agents idle and mid-turn (for example during a `sleep 20` tool call). Run each at least twice.

1. **Herdr client detach and reattach.** Do the agents keep running? This is expected; confirm it quickly.
2. **Graceful server stop, then start** (`herdr --session loom-s05 server stop`, then start it again).
   - Do the pane processes survive? Compare PIDs.
   - Try `resume_agents_on_restore` set to `true` and to `false`. What does Herdr restore: layout, working directory, agent names, relaunched agents?
   - Does a relaunched Claude come back with the same session ID or a new one?
   - Does a relaunched Codex TUI keep its `--remote` socket argument?
   - What state is a turn that was mid-flight in afterwards? Check the transcript and `thread/read`.
3. **Server killed.** SIGKILL the named session's server process only; first check that its PID belongs to
   `loom-s05`. Ask the same questions as in 2.
4. **Recovery by Loom.** After each fault, write down the steps a reconciler would take to get every agent
   back to a working, attachable state. Use only stored IDs (session or thread IDs, worktree path) and
   read-only discovery (`herdr agent list`, `claude agents --json`, `thread/read`). Try those steps. How long
   does recovery take?

## Deliverable

`FINDINGS.md`, containing:
- a table with one row per fault, moment and provider, and these columns: did the process survive · same session or thread ID? · what Herdr
  restored · recovery steps · time;
- the recommended `resume_agents_on_restore` setting for sessions Loom manages;
- a recovery procedure for each fault, written as steps the reconciler can follow.
