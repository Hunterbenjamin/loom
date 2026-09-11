# Spike 05: Restart and recovery matrix

**Agent:** claude · **Timebox:** about 3 hours · **Depends on:** spikes 01 and 02 merged. Reuse their client
and hook server. Read `spikes/README.md` first.

## Why

Loom promises that nothing is lost when something restarts. This spike measures what actually survives, so
the reconciler is designed around facts.

## Isolation

The rules here are stricter than for the other spikes.

- Use a separate named Herdr session for everything. See `herdr session --help` and `herdr --help`, and work
  out how to run that session headless. Never stop or restart the user's main Herdr server.
- Use a private Codex app-server socket, as in spike 01. Never touch the shared daemon.

## Matrix

**Components to kill or restart:**
- the probe client (a stand-in for the coordinator);
- the Herdr client;
- the Herdr server (the named session only);
- the private Codex app-server;
- the claude process;
- the codex TUI.

**At each moment:** idle, mid-turn, waiting for approval.

**For each combination, record:**
- Does the agent process survive?
- Is the session or thread recoverable, and by which ID and command?
- Which events were lost? Can the state be re-read afterwards (`thread/read`, the transcript,
  `herdr agent get`, `claude agents --json`)?
- How long does recovery take?

Also: after a Herdr server restart, do the pane processes survive, and what does Herdr restore?

## Deliverable

`FINDINGS.md`, containing the matrix and a recovery procedure for each component. Write each procedure as steps the
reconciler can follow.
