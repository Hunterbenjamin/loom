# Spike 05: What survives each kind of restart, and how do we recover?

Versions observed: herdr 0.9.0 · codex-cli 0.154.0 · Claude Code 2.1.268
(version query only) · Node 23.6.0 · npm 10.9.2 · pnpm 10.0.0 · git 2.51.2 ·
GitHub CLI 2.90.0 · Python 3.13.1 · macOS 26.2 (25C56).

**Outcome: timeboxed before restart experiments. No matrix row was tested.**
This is an incomplete spike, not evidence that recovery works or fails.

## Summary

| Question | Result | One-line answer |
|---|---|---|
| Can an isolated named Herdr server run headless? | works with caveats | Startup succeeded after sandbox approval; named-session socket access also required approval. |
| What survives coordinator/probe or Herdr client restart? | untested | No component was restarted at a measured provider state. |
| What survives a named Herdr server restart? | untested | Startup and cleanup were observed; process survival and restore behavior were not measured. |
| What survives private Codex app-server or Codex TUI restart? | untested | No Codex server, TUI, thread, or turn was launched. |
| What survives Claude process restart? | untested | Claude model calls were held for the user's usage pause; the timebox expired before testing began. |
| Which events are lost, and how long does recovery take? | untested | No before/after event or timing samples exist. |

`untested` is intentional rather than forcing an unsupported works/doesn't result.

## Evidence

### Timebox and prerequisite check

The first recorded clock check was **2026-09-11 11:21:23 UTC / 19:21:23
Asia/Makassar**. The approximately three-hour deadline was therefore about
**14:21 UTC / 22:21 local**; setup had already begun just before that check.

The user then instructed us to run Herdr/Codex first and make no Claude model
calls before **22:10 local**. No Claude model calls were made at any time.
After the pending setup approval completed, the next clock check was
**2026-09-11 19:19:31 UTC / September 12 03:19:31 local**, already past the
deadline. Experiments stopped at that point. Only cleanup, this report,
repository checks, and the requested Git/PR delivery continued.

Read `AGENTS.md`, `spikes/README.md`, this spike's `BRIEF.md`,
`docs/architecture.md`, spike 01's client/setup/findings, and spike 02's hook
server/settings/findings. The prerequisite commits were present in this branch:

```text
$ git log -8 --oneline
7c8f21d Spike 02: Claude Code hooks, status and Herdr prompt delivery (#5)
...
4d7e298 Spike 01: Codex TUI and coordinator share a live app-server thread (#1)
```

The worktree began clean on `spike/05-restart-matrix`.

### Isolated setup: one successful headless startup, zero restart trials

CLI help discovery established:

```text
$ herdr --help
herdr --session <name> [options]
herdr server                     Run as headless server

$ herdr session --help
list / attach / stop / delete

$ herdr --session loom-spike-05-restart-matrix --default-config
[session]
# resume_agents_on_restore = true
[experimental]
# allow_nested = false
```

The two initial help calls were discovery only, before the user's explicit
named-session reminder. All subsequent Herdr commands included
`--session loom-spike-05-restart-matrix`; no default-session control or inventory
command was used. `HERDR_ENV=1` was checked before control.

Created a throwaway Git repository and per-experiment configuration under
`$TMPDIR/loom-spike-05/`. The Herdr config disabled onboarding, update checks,
and sounds, used `/bin/sh`, enabled nested clients, and explicitly enabled
`resume_agents_on_restore`. The latter was preparation, not a tested result.
No global configuration was edited.

```text
$ HERDR_CONFIG_PATH="$TMPDIR/loom-spike-05/herdr/config.toml" \
    herdr --session loom-spike-05-restart-matrix server
# First attempt, sandboxed:
Error: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }

# Same command after sandbox approval:
herdr server running; you can use any herdr CLI command in another terminal.
api socket: ~/.config/herdr/sessions/loom-spike-05-restart-matrix/herdr.sock
client socket: ~/.config/herdr/sessions/loom-spike-05-restart-matrix/herdr-client.sock
logs: ~/.config/herdr/sessions/loom-spike-05-restart-matrix/herdr-server.log
```

Paths above abbreviate the user home. Herdr placed named-session runtime state
in its own session directory despite `HERDR_CONFIG_PATH`; this flag changed the
configuration file, not the session storage root. The fixture repo/config stayed
under `$TMPDIR/loom-spike-05/`.

One sandboxed `herdr --session loom-spike-05-restart-matrix status --json`
attempt also failed with `Operation not permitted`. A chained workspace listing
therefore never ran. No pane IDs or provider session IDs were obtained.

Cleanup after the deadline:

```text
$ HERDR_CONFIG_PATH="$TMPDIR/loom-spike-05/herdr/config.toml" \
    herdr --session loom-spike-05-restart-matrix server stop
# Approved outside the sandbox; exit 0, no output.
```

This stop was cleanup, not a restart experiment. There was no subsequent
relaunch/readback to establish restore behavior. Only the test-created named
session was targeted. No shared Herdr server or Codex daemon was controlled.
A temporary Codex credential symlink was removed without opening or changing
its target. The prepared Codex configuration was never used to launch a server.
An unfinished adaptation of the spike 01 client and its dependency manifests
were removed rather than committing unexecuted probe code. No hook receiver ran.

### Restart matrix

Every row has **n=0**. “Unknown” includes survival, same-ID recoverability,
event loss, and recovery latency; it must not be interpreted as failure.
Idle/mid-turn/approval refer to provider state at the proposed fault, not the
state of the component being killed. Herdr/probe rows need provider-specific
observations in a follow-up.

| Component killed/restarted | Moment | Agent process survives? | Session/thread recovery ID and command | Lost events / state reread | Recovery time | Trials |
|---|---|---|---|---|---|---|
| Probe client / coordinator stand-in | idle | Unknown | Untested | Untested | Unmeasured | 0 |
| Probe client / coordinator stand-in | mid-turn | Unknown | Untested | Untested | Unmeasured | 0 |
| Probe client / coordinator stand-in | waiting for approval | Unknown | Untested | Untested | Unmeasured | 0 |
| Herdr client | idle | Unknown | Untested | Untested | Unmeasured | 0 |
| Herdr client | mid-turn | Unknown | Untested | Untested | Unmeasured | 0 |
| Herdr client | waiting for approval | Unknown | Untested | Untested | Unmeasured | 0 |
| Herdr server, named session only | idle | Unknown | Untested | Untested | Unmeasured | 0 |
| Herdr server, named session only | mid-turn | Unknown | Untested | Untested | Unmeasured | 0 |
| Herdr server, named session only | waiting for approval | Unknown | Untested | Untested | Unmeasured | 0 |
| Private Codex app-server | idle | Unknown | Untested | Untested | Unmeasured | 0 |
| Private Codex app-server | mid-turn | Unknown | Untested | Untested | Unmeasured | 0 |
| Private Codex app-server | waiting for approval | Unknown | Untested | Untested | Unmeasured | 0 |
| Claude process | idle | Unknown | Untested | Untested | Unmeasured | 0 |
| Claude process | mid-turn | Unknown | Untested | Untested | Unmeasured | 0 |
| Claude process | waiting for approval | Unknown | Untested | Untested | Unmeasured | 0 |
| Codex TUI | idle | Unknown | Untested | Untested | Unmeasured | 0 |
| Codex TUI | mid-turn | Unknown | Untested | Untested | Unmeasured | 0 |
| Codex TUI | waiting for approval | Unknown | Untested | Untested | Unmeasured | 0 |

## Implications for Loom

**No architecture claim was promoted to verified, and no architecture principle
was changed.** This run establishes only the headless launch command and the
need to budget for sandbox approvals. It provides no new recovery guarantees.

Keep spike 05 open. In particular, do not treat Herdr's restore option as proof
that a pane process survives or that a remote Codex TUI's launch arguments are
preserved. Confirm ownership and compare original PIDs, restored PIDs, provider
IDs, and process arguments before describing a run as surviving or resumed.

### Candidate recovery procedures — not validated by spike 05

These are bounded follow-up procedures for the reconciler, derived from the
existing architecture and [spike 01](../01-codex-shared-thread/FINDINGS.md) /
[spike 02](../02-claude-hooks/FINDINGS.md). Their prior observations are **not
matrix samples from this run**. Test each at all three moments before adopting
it as a production recovery contract.

**Probe client / coordinator**

1. Load persisted task, canonical worktree, provider session ID, pane references,
   and provider-owner connection generation. Mark disconnected live status unknown.
2. Reconnect to the owning Codex server, initialize, `thread/resume` the stored
   thread ID to subscribe, and hydrate using `thread/read` with `includeTurns`.
   Buffer notifications while reconciling the snapshot; do not replay side effects.
3. For Claude, restore the hook endpoint and reconcile owned sessions using
   `claude agents --json` and their transcripts; do not assume missed hooks replay.
4. Reconcile pending attention and worktree/tool state before any retry or stage
   change. Scope approval request IDs to the server generation.

**Herdr client**

1. Confirm the named server and the provider's authoritative state remain reachable.
2. Reattach a client with `herdr --session <owned-session>`; resolve pane identity
   from that session's API rather than assuming the focused pane is the task.
3. Hydrate provider state and approvals. Do not launch a replacement agent merely
   because a terminal client disconnected.

**Herdr server**

1. Establish that the particular owned server has exited; retain provider state
   as unknown until its owner can be queried. Never target the default server.
2. Start that named session headless with the same per-experiment configuration.
3. Inspect restored topology and exact pane processes, then correlate canonical
   worktree and stored provider ID. Distinguish surviving PIDs from relaunched
   shells/agents; do not let the coordinator race Herdr's automatic restoration.
4. For a still-running private Codex server, recover the existing thread there.
   Before resuming a vanished Claude process, confirm no owner still runs it.
   Validate remote socket/model arguments on any automatically restored Codex TUI.
5. Reconcile tool side effects and pending attention before deciding whether a
   new turn is needed. Automatic restore and process survival remain untested.

**Private Codex app-server**

1. Verify loss of the known private server, then restart only that socket with
   the same isolated data directory. Advance the connection generation.
2. Initialize a client and recover the stored thread using `thread/resume` and
   `thread/read`. Discard old connection-bound approval handles.
3. Inspect saved turn history and the actual worktree/tool state. Spike 01 saw
   an unfinished turn recover as interrupted and a pending command absent from
   disk history; absence from the transcript is not proof it never executed.
4. Require a fresh, validated action before continuing an interrupted turn;
   never automatically accept an approval from the previous generation.

**Claude process**

1. Confirm the owned PID is gone using process state and owned-session discovery;
   missing hooks alone are insufficient. Read the recorded transcript path.
2. Reconcile the interrupted prompt and any external/tool side effects. Spike 02
   observed no SessionEnd on SIGKILL and incomplete in-flight tool history.
3. Launch one replacement with `claude --resume <stored-session-id> --model haiku`
   and the same per-process hook settings, only after exclusive ownership is known.
4. Require matching session/worktree evidence from the SessionStart command hook
   and provider discovery; rebuild attention from current state rather than an
   old PermissionRequest. Do not infer that the killed turn resumed execution.

**Codex TUI**

1. Re-read the thread from its still-owning private app-server before replacing
   the TUI; TUI loss alone does not establish model-turn failure.
2. In a new owned pane, run `codex resume <stored-thread-id> --remote
   unix://<owned-socket>` with the same per-process configuration and worktree.
3. Hydrate history/current status and reconcile pending server requests. If the
   server also disappeared, use the server procedure first; never silently fall
   back to a separate embedded runtime with the same thread history.

## Open questions

- All 18 matrix cells, including repetition counts and recovery latency.
- After a named Herdr server crash versus graceful stop, which pane processes
  survive, which layout/session references restore, and which arguments are lost?
- How does automatic Herdr restoration interact with a separately surviving
  private Codex app-server and a coordinator attempting recovery simultaneously?
- Which approvals reappear after reconnect, which become invalid after restart,
  and how are events emitted during a disconnected interval recovered?
- Which in-flight tools outlive each parent process, and how can their effects
  be reconciled without duplicate execution?
- How reliably does Claude resume at idle, mid-tool, and approval states after
  the account's usage pause ends? No availability probe was made after the pause.

## How to rerun

This report contains setup evidence and a test plan, **not an executable completed
matrix harness**. A follow-up needs a fresh timebox and an available provider
window, including time for platform approvals.

1. Read the spike rules, brief, architecture, and prerequisite findings. Keep
   all throwaway repos/data under `$TMPDIR/loom-spike-05/`; choose a fresh
   temporary parent if an earlier fixture exists. Do not overwrite old evidence.
2. Use a fresh owned named Herdr session and explicit `--session <name>` on every
   command. Use `HERDR_CONFIG_PATH` for a temporary config. Start it with
   `herdr --session <name> server`, then verify scoped status/API access before
   launching providers. Never stop/restart a default or shared server.
3. Adapt spike 01's validated client and setup under this spike directory, with
   root guards changed from `loom-spike-01` to `loom-spike-05`. Its original
   `run.ts` contains unscoped Herdr calls: do not run that driver unchanged.
   Use `codex app-server --listen unix://$TMPDIR/loom-spike-05/codex.sock` with
   isolated provider state and per-process flags. Query `model/list`, record the
   smallest listed model, and use it for trivial prompts.
4. Reuse spike 02's hook server, adding boundary validation/redaction before
   retaining evidence. Use a command hook for SessionStart and HTTP hooks for
   the supported events. Record Claude session UUIDs before launch and use
   `--model haiku`. Gate all real-provider drivers with `LOOM_REAL_PROVIDERS=1`;
   automated tests must remain offline.
5. For each cell, record known owned PIDs and provider IDs, establish the intended
   state through native provider events/snapshots, timestamp the targeted fault,
   reconnect/restart, and capture the authoritative post-fault state. Keep kill
   and graceful-restart cases distinct. Do not parse terminal output for decisions.
6. Record process survival, same-ID history recovery, live-turn continuation,
   approval behavior, missing events versus recovered state, and elapsed time
   separately. Inspect only owned sessions. Test safe fixture side effects to
   detect orphan tools or duplicate execution before retrying anything.
7. Stop within the timebox, clean up only owned resources, record untested cells
   explicitly, run the required repo checks, and deliver a draft PR.

Repository checks for this documentation-only result:

```sh
pnpm test
pnpm lint
pnpm typecheck
git diff --check
```

Results: all three pnpm commands exited 0. Vitest found no product test files;
Biome checked four repository files; recursive typecheck found no product
projects. These checks do not exercise this matrix or validate the candidate
recovery procedures. Whitespace checking passed. The only committed change is
this report.
