# Spike 01: Codex shared live thread

**Agent:** codex · **Timebox:** about 3 hours · **Depends on:** nothing. Read `spikes/README.md` first.

## Why

Loom's coordinator will drive Codex through the app-server protocol, and the human will attach to the same
thread from a terminal to watch or step in. The docs say several clients can subscribe to one thread, but
nobody here has tested the TUI as one of those clients. If it doesn't work, Loom needs a handoff model instead,
where only one client holds the thread at a time.

## Setup

- **Throwaway repo:** a git repo with a few files under `$TMPDIR/loom-spike-01/repo`.
- **Private app-server:** run `codex app-server --listen unix://$TMPDIR/loom-spike-01/codex.sock` in its own pane
  in your workspace. Never stop, restart or reconfigure the shared daemon.
- **Test client:** a minimal TypeScript client in this directory, using bindings from `codex app-server generate-ts`. It must:
  - `initialize`;
  - `thread/start` with the throwaway repo as its working directory;
  - `turn/start`;
  - log every message as JSONL;
  - accept commands from stdin: steer, interrupt, approve, decline.
- **Attach the TUI** from another pane: `codex resume <threadId> --remote unix://$TMPDIR/loom-spike-01/codex.sock`.

## Questions

1. **Live attach.** With the client mid-turn:
   - Does the TUI show the thread's history and the live stream?
   - Can both sides send input (a message from the TUI; `turn/start` or `turn/steer` from the client)?
   - What does each side see?
2. **Approvals.** Use an approval policy that requires command approval.
   - Which clients receive `item/commandExecution/requestApproval`?
   - When one client answers, does the other client's prompt clear?
   - What happens if nobody answers?
3. **Interrupt.** The client sends `turn/interrupt` mid-turn. Does the TUI reflect it? Check the reverse too
   (Esc in the TUI).
4. **Detach.** Close the TUI mid-turn, then close the client.
   - Does the turn keep running with no subscribers?
   - Reconnect the client with `thread/resume`. Does it get the current state and the events that follow?
5. **Crash.** Kill the private app-server mid-turn.
   - What can be recovered from disk, using `thread/read` and `thread/resume` on a fresh server?
   - Is the interrupted turn marked as such?
6. **Status mapping.** Which notifications or requests tell us that the agent is:
   - working;
   - waiting for approval;
   - waiting for user input (`item/tool/requestUserInput`);
   - idle;
   - failed;
   - rate-limited (`account/rateLimits/read`, `account/rateLimits/updated`)?

   Propose the mapping table.
7. **Sessions started outside Loom.** Start plain `codex` in a pane inside the throwaway repo.
   - Does it use a daemon or an embedded server?
   - Can a client find that thread (`thread/list`, `thread/loaded/list`, read-only `thread/read`) without
     disturbing it?

   Against the shared daemon, make only read-only calls, and only for threads you started.

## Deliverable

`FINDINGS.md`, including the status mapping table and a recommendation: concurrent attach, or handoff. Keep
the client code; it's the starting point for `packages/adapters/codex`.
