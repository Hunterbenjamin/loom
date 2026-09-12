# Spike 05: What survives each kind of restart, and how do we recover?

Versions: herdr 0.9.0 (private protocol 22; agent-detection manifest `remote/codex.toml 2026.09.05.1`;
codex integration hook v8) · Claude Code 2.1.269 (`--model haiku`) · codex-cli 0.154.0
(`model = "gpt-5.6-luna"`, `model_reasoning_effort = "low"`) · Node 23.6.0 · ws 8.21.3 · Python 3.13.1 ·
macOS 26.2 (25C56) on an Apple M3.

Everything ran in a separate headless Herdr session, `loom-s05`, started as
`HERDR_CONFIG_PATH=$TMPDIR/loom-spike-05/herdr/config.toml herdr --session loom-s05 server` with every
`HERDR_*` and `CLAUDE_CODE_*` variable scrubbed from its environment, against a throwaway git repo at
`$TMPDIR/loom-spike-05/repo`. Agents: `s05-claude`
(`claude --session-id f2dfb973-… --settings $SPIKE/loom.settings.json --model haiku`, pane `w1:p1`) and
`s05-codex` (a Codex TUI on `--remote unix://$TMPDIR/loom-spike-05/codex.sock`, pane `w1:p2`, later `w1:p3`).

**The Codex app-server ran outside Herdr** — a detached process started from the repo with
`CODEX_HOME=$TMPDIR/loom-spike-05/home`. That choice decides the answer for Codex, so section 5 measures the
other arrangement (app-server in a pane of the session) as well.

The user's main Herdr server, the shared Codex daemon and all global config were left alone; only panes this
spike created were read or driven. Every kill was guarded by checking that the target pid's argv contained
`--session loom-s05 server`.

## Summary

| Question | Result | One-line answer |
|---|---|---|
| 1. Client detach and reattach | works | No effect at all, idle or mid-turn: same PIDs, same session and thread IDs, turns finish normally. |
| 2. Graceful server stop, then start | works with caveats | **No pane process survives** — every PID is new. With `resume_agents_on_restore = true` Herdr restores the workspace, tab, layout, cwd and agent names and relaunches each agent on its own session/thread, but from a *canonical* resume command: Claude loses `--settings` and `--model`, Codex loses `--remote`, and neither keeps the pane's exported environment. |
| 2b. `resume_agents_on_restore = false` | works | Panes, tab, layout and cwd come back holding a bare login shell. No agent entries, no names, no session refs, nothing relaunched. |
| 3. Server SIGKILL | works with caveats | Indistinguishable from a graceful stop for the agents — same losses, same restore, just faster to go down (0.03–0.07 s vs 0.7–0.9 s). No extra damage. |
| 4. Mid-flight turns | works with caveats | Claude's turn is lost (its tool call ends `Exit code 137`, no final message). A Codex turn **completes** if the app-server is outside Herdr, and ends `interrupted` if the app-server was in a pane. |
| 5. Recovery by Loom | works | From stored IDs plus read-only discovery: both agents relaunched in 20 s, both answering a new prompt 35 s after the fault. Loom must relaunch them itself. |

**Recommended setting: `resume_agents_on_restore = false` for sessions Loom manages.** Reasoning under
"The setting".

## Evidence

Scripts are in this directory. `env.sh` holds the shared paths and the environment scrubber; `server.sh`
starts/stops the spike's own Herdr server with a chosen `resume_agents_on_restore`; `snapshot.sh` + `fmt.py`
record one line per fact from `herdr agent list`, `herdr pane process-info`, `claude agents --json` and
`thread/read`; `thread-read.mjs` is a 50-line app-server client (transport from spike 01:
`ws+unix://<sock>:/rpc`, `Host: localhost`, no permessage-deflate); `prompt.sh` puts both agents mid-turn on a
~30 s tool call; `fault.sh` applies one fault and records both sides of it; `recover.sh` is the recovery
procedure below, written as shell. The full trial log is `$TMPDIR/loom-spike-05/logs/trials.log`; everything
quoted below is trimmed from it.

Trials run, counting only those where both agents were in the intended state when the fault landed:
detach/reattach 2× idle and 2× mid-turn; graceful stop with `resume_agents_on_restore = true` 3× idle and
2× mid-turn; graceful stop with it `false` 2× idle and 2× mid-turn; SIGKILL 2× idle and 2× mid-turn; one
end-to-end fault → recovery → both agents answering; one graceful stop with the app-server in a pane. Two
further mid-turn attempts are in the log but are not counted: in one, Claude sat at a permission prompt (the
`--settings` allowlist had been dropped by the previous restore) and Codex never started its turn; in the
other, Codex's pane had lost its agent name, so `herdr agent prompt` never reached it.

### The matrix

| Fault | Moment | Provider | Process survived | Same session / thread ID | What Herdr restored | Recovery | Time |
|---|---|---|---|---|---|---|---|
| Client detach / reattach | idle | Claude | yes, same PID | yes | n/a | none needed | 0 s |
| Client detach / reattach | idle | Codex | yes, same PID | yes | n/a | none needed | 0 s |
| Client detach / reattach | mid-turn | Claude | yes, same PID | yes; turn finishes | n/a | none needed | 0 s |
| Client detach / reattach | mid-turn | Codex | yes, same PID | yes; turn finishes | n/a | none needed | 0 s |
| Graceful stop (`resume = true`) | idle | Claude | **no** | yes — relaunched `claude --resume <same id>`, **without `--settings` or `--model`** | workspace, tab, layout, cwd, agent name, session ref | quit it, `herdr agent start` with the stored flags | ~10 s |
| Graceful stop (`resume = true`) | idle | Codex | **no** | yes — relaunched `codex resume <same thread>`, **without `--remote`**, and with no `CODEX_HOME`, so it lands on the user's `~/.codex` and stops at a trust prompt | workspace, tab, layout, cwd, agent name, session ref | quit it, `herdr agent start` with `resume <thread> --remote <sock>`, then `pane report-agent-session` | ~10 s |
| Graceful stop (`resume = true`) | mid-turn | Claude | **no** | yes, but the turn is lost: transcript ends at the tool call with `Exit code 137` | as above | as above, then re-send the prompt | ~10 s |
| Graceful stop (`resume = true`) | mid-turn | Codex | **no** (the TUI dies; the app-server outside Herdr does not) | yes; the turn **completes** in the app-server | as above | as above; `thread/read` already has the answer | ~10 s |
| Graceful stop (`resume = false`) | idle and mid-turn | both | **no** | n/a — nothing is relaunched, the pane holds `-zsh` | workspace, tab, layout, cwd only | `herdr agent start` in the restored pane from stored IDs | ~20 s for both |
| SIGKILL (`resume = true`) | idle and mid-turn | both | **no** | same as graceful stop in every respect | same as graceful stop | same as graceful stop | ~20 s for both |
| Graceful stop, app-server **in a pane** | mid-turn | Codex | **no** — the app-server dies with the session | thread survives on disk; the turn ends `interrupted`, thread `status: notLoaded` | Herdr relaunched **the app-server's pane** as `codex resume <thread>` (an interactive TUI), and left the real TUI pane as `-zsh` | restart the app-server, then the TUI | not recommended; see section 5 |

### 1. Client detach and reattach

`herdr agent attach` run under `script -q /dev/null`, then killed. Idle and mid-turn, twice each. Nothing
moves — same foreground PIDs, same session and thread IDs, same statuses, and the mid-turn turns finish:

```
== F1-r2-midturn-before  11:31:30
herdr-agent s05-claude  pane=w1:p1 status=working  session=f2dfb973-…
herdr-agent s05-codex   pane=w1:p3 status=working  session=01a09395-…
claude-agents id=f2dfb973-… status=busy pid=67193
thread 01a09395-… status={"type": "active", …} turns[-3]: fb5f9c=completed, 3308ce=inProgress
== F1-r2-midturn-attached  11:31:34      (identical)
== F1-r2-midturn-detached  11:31:35      (identical)
```

### 2. Graceful server stop, then start

`herdr --session loom-s05 server stop`, then `server.sh start <resume>`. The server is down in 0.7–0.9 s and
back up in 0.25 s; the whole fault-to-server-up window was 4.6–5.3 s in every run.

**Pane processes do not survive.** Every PID — the agents *and* the panes' login shells — is new afterwards:

```
pids-before claude=56687 codex=56767 shell1=55400
pid 56687 GONE
pid 56767 GONE
pid 55400 GONE
```

**With `resume_agents_on_restore = true`** Herdr brings back the workspace, its tab, the split layout, each
pane's cwd, the agent names and the recorded session refs, and relaunches both agents on their own sessions —
but from a canonical resume command, not the one they were started with:

```
== F2-idle-r1-before  11:12:54
pane w1:p1 shell_pid=31794 fg_pid=35591 argv=claude --resume f2dfb973-… --settings /…/loom.settings.json --model haiku
pane w1:p2 shell_pid=32428 fg_pid=34490 argv=…/codex --remote unix:///…/loom-spike-05/codex.sock
== F2-idle-r1-after   11:12:59
herdr-agent s05-claude  pane=w1:p1 status=unknown  session=f2dfb973-…   ← same session id
herdr-agent s05-codex   pane=w1:p2 status=unknown  session=01a09395-…   ← same thread id
pane w1:p1 shell_pid=36958 fg_pid=37918 argv=claude --resume f2dfb973-…          ← --settings, --model dropped
pane w1:p2 shell_pid=36959 fg_pid=37956 argv=…/codex resume 01a09395-…           ← --remote dropped
claude-agents id=f2dfb973-… status=idle pid=37918
restored-pane w1:p1 … cwd=/private/…/loom-spike-05/repo
restored-pane w1:p2 … cwd=/private/…/loom-spike-05/repo
total-fault-to-server-up=4.77s
```

- **Claude comes back with the same session ID** (`--resume f2dfb973-…`, and `claude agents --json` lists that
  ID against the new pid). It does **not** come back with `--settings` or `--model`. Per spike 02, `--settings`
  is how an interactive session gets Loom's hooks and permission rules, so the relaunched agent is a session
  Loom can no longer observe or safely drive; in one mid-turn trial the next prompt stopped at a permission
  prompt (`claude agents … status=waiting`) that the dropped settings file would have allowed.
- **The Codex TUI does not keep `--remote`.** It is relaunched as a plain `codex resume <thread>`, and the
  pane's exported `CODEX_HOME` is gone too (pane environment is not part of what is restored), so it starts
  against the user's own `~/.codex` and stops at `Do you trust the contents of this directory?` — connected to
  nothing, holding a thread id its local home has never seen.
- Herdr's own `agent_status` is `unknown` for a few seconds after the restart and then settles.

**With `resume_agents_on_restore = false`** the panes come back holding nothing but a shell, and `herdr agent
list` is empty — no names and no session refs, so the only join key left is the pane's cwd:

```
== F2-idle-false-r2-after  11:28:00
pane w1:p1 shell_pid=57340 fg_pid=57340 argv=-zsh
pane w1:p3 shell_pid=57341 fg_pid=57341 argv=-zsh
claude-agents (our session absent)
restored-pane w1:p1 … cwd=/private/…/loom-spike-05/repo
restored-pane w1:p3 … cwd=/private/…/loom-spike-05/repo
```

### 3. Server killed

`kill -9` on the pid whose argv is `herdr --session loom-s05 server`, checked before signalling. The outcome is
the same as a graceful stop in every respect measured; only the timings differ (`server-down-after=0.03–0.07s`,
`total-fault-to-server-up=3.65–3.85s`). The pane processes are not orphaned: they get their PTY closed and
exit. In one run Claude was still alive 2 s after the kill and gone by the next snapshot:

```
server-pid=61792 argv=herdr --session loom-s05 server
server-down-after=0.03s
pid 63091 ALIVE: claude --resume f2dfb973-… --settings /var/f…
pid 63178 GONE
pid 61794 GONE
== F3-idle-r2-after  11:29:44
pane w1:p1 shell_pid=63459 fg_pid=64311 argv=claude --resume f2dfb973-…       ← new pid, --settings dropped
```

### 4. What happens to a turn that was mid-flight

**Claude loses it.** The transcript keeps the prompt and the tool call, and the tool result is the kill:

```
03:15:45.704Z user       | Use the Bash tool to run this exact command: python3 -c 'import time; time.sleep(30)' …
03:15:47.764Z assistant  | Bash
03:15:56.227Z user       | Exit code 137
                          (no assistant message after it)
```

`claude agents --json` shows the resumed session `idle` immediately — there is no "was interrupted" state to
read, which matches spike 02, section 5. A reconciler has to re-send the prompt.

**Codex keeps it, as long as the app-server is outside Herdr.** In all six mid-turn trials the turn that was
`inProgress` when the server died was `completed` when read back afterwards — the TUI is only a client:

```
== F3-midturn-r1-before  11:24:57
thread 01a09395-… status={"type":"active"} turns[-3]: 852386=completed, d6f11f=completed, b0f877=inProgress
pid 50772 GONE / pid 50298 GONE / pid 48955 GONE
== F3-midturn-r1-+35s    11:25:40
thread 01a09395-… status={"type":"idle"}   turns[-3]: 852386=completed, d6f11f=completed, b0f877=completed
```

### 5. The app-server in a pane of the session

Run once, mid-turn, with a second private app-server started by `herdr pane run w1:p4 'CODEX_HOME=… codex
app-server --listen unix://…'` and a TUI in `w1:p5` pointed at it. A graceful stop:

```
before: thread 01a093ac-… status={"type":"active"} turns[-3]: 6f83a9=completed, 3fe298=inProgress
app-server pane fg pid=68609
app-server GONE            socket removed
restored panes: w1:p1, w1:p5, w1:p3, w1:p4
pane w1:p4 … argv=…/codex resume 01a093ac-61a5-7c03-92f4-a14272d0314f   ← the app-server's pane
pane w1:p5 shell_pid=69747 fg_pid=69747 argv=-zsh                       ← the TUI's pane
read back from a fresh app-server:
thread 01a093ac-… status={"type":"notLoaded"} turns[-3]: 6f83a9=completed, 3fe298=interrupted
```

Two things go wrong. The turn ends `interrupted` (spike 01's app-server-crash behaviour) instead of completing.
And Herdr resumed the thread **in the app-server's pane**, because that is the pane the Codex integration
attributed it to — see below — leaving the actual TUI pane as a bare shell.

### 6. How Herdr learns a Codex thread id (and when it doesn't)

`herdr agent list` only reports `agent_session` for Codex if the integration's `SessionStart` hook runs, and
that hook runs **in the process that owns the session**. With `--remote` that is the app-server, not the pane:

- With the stock isolated `CODEX_HOME` (no `hooks.json`), `agent_session` stayed `None` through a first turn.
- Copying `~/.codex/hooks.json` + `herdr-agent-state.sh` into the isolated home was not enough either: the hook
  exits early unless `HERDR_ENV`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are set, and the app-server had none.
  Codex also holds the hook at a review prompt (`⚠ 1 hook needs review before it can run`) until it is trusted.
- Starting the app-server with `HERDR_ENV=1 HERDR_SOCKET_PATH=… HERDR_PANE_ID=w1:p2` made the ref appear — but
  only on the **first turn of a new thread** (the thread is created lazily), and pinned to whatever pane id the
  app-server was given. That is why section 5's restore resumed the thread in the app-server's pane.
- The hook does not fire on `codex resume`, so after any recovery the ref is missing again.

Loom does not need the hook: it knows the thread id, and can report it itself. The `--source` must be the
integration's id (`loom` is accepted and silently ignored):

```sh
herdr pane report-agent-session --source herdr:codex --agent codex \
  --agent-session-id 01a09395-… --session-start-source resume --seq <ns> w1:p3
→ agent_session: {'agent':'codex','kind':'id','source':'herdr:codex','value':'01a09395-…'}
```

### 7. Two smaller traps

- **Herdr's Codex status can stay wrong after a restart.** Detection reads the OSC title; a TUI killed mid-turn
  leaves a spinner title behind, and the resumed TUI never rewrites it, so the agent reads `working` forever:
  `herdr agent explain s05-codex → rule: osc_title_working … evidence: "⠧ Reply exactly S05_CODEX_ONE | repo"`.
  `herdr agent prompt <name> --wait` then blocks indefinitely even though the prompt was delivered and answered
  (verified in the pane). `thread/read` said `idle` the whole time.
- **`herdr agent start` reports a timeout for a resumed Codex TUI** (`{"error":{"code":"timeout","message":"timed
  out waiting for agent startup"}}`) for the same reason, while the process is up and driveable. Name it with
  `herdr agent rename <pane> <name>` afterwards. Note that a name set that way did **not** come back after the
  next restart (2 observations), while names set by a successful `herdr agent start` did.

## The setting

**Use `resume_agents_on_restore = false` for sessions Loom manages**, and let the coordinator relaunch agents.

`true` does restore more — but everything extra it restores is wrong for Loom, and wrong in ways that are
expensive to detect:

- it drops `--settings`, so a Claude session comes back without Loom's hooks and permission rules, still
  carrying the session id Loom is tracking;
- it drops `--remote` and the pane environment, so a Codex TUI comes back pointed at the user's `~/.codex` and
  parked on a trust prompt;
- with the app-server in a pane, it resumes the thread in the wrong pane entirely;
- and it produces panes that *look* recovered to `herdr agent list` (right name, right session ref) while being
  unusable, which is the worst input a reconciler can get.

With `false`, the restored state is unambiguous — a pane at a shell prompt, in the right worktree — and
reconciliation is a single decision: this task has a session id and no live process, so relaunch it.

## Recovery procedure

`recover.sh` implements this; it uses only stored IDs (Claude session id, Codex thread id, worktree path) and
read-only discovery (`herdr agent list`, `herdr pane list`, `claude agents --json`, `thread/read`).

**After any Herdr fault (stop, SIGKILL, or crash):**

1. `herdr status server`; if it is down, start the session's server again. (0.3 s)
2. For each task with a live worktree, find its pane: `herdr agent list` by kind + cwd, falling back to
   `herdr pane list` by cwd when the panes came back as bare shells. The worktree path is the join key; pane
   ids are not stable across a `pane close`.
3. Decide whether the agent is really running by reading the **provider**, never Herdr's `agent_status`:
   `claude agents --json` (our session id present, with a pid) and `thread/read` on the stored thread id.
4. If Herdr relaunched something (`resume_agents_on_restore = true`), quit it first — `/exit` + Enter for
   Claude, `Ctrl+C` twice for Codex — and never `exit` the pane's shell, which closes the pane and loses the
   layout.
5. Relaunch with the full stored command line:
   - Claude: `herdr agent start <name> --kind claude --pane <pane> -- --resume <session-id> --settings <loom settings> --model <model>`
   - Codex: make sure the app-server is up (it is Loom's process, outside Herdr, one per worktree), then
     `herdr agent start <name> --kind codex --pane <pane> --timeout 8000 -- resume <thread-id> --remote unix://<sock>`,
     then `herdr agent rename <pane> <name>` because that start call reports a timeout it did not really hit.
6. Report the Codex thread id back to Herdr yourself:
   `herdr pane report-agent-session --source herdr:codex --agent codex --agent-session-id <thread> --session-start-source resume --seq <ns> <pane>`.
7. Reconcile the turn:
   - Codex: `thread/read` is the owner. If the last turn is `completed`, the work happened while Herdr was
     down — read it and move on. If it is `interrupted` (only seen when the app-server itself died), re-send.
   - Claude: assume the in-flight turn is lost. The transcript's last tool result will be `Exit code 137` with
     no assistant message after it; re-send the prompt.

**After a Claude process dies but Herdr is fine:** steps 2, 3, 5 (Claude only), 7.

**After the Codex app-server dies but Herdr is fine:** restart the app-server on the same `CODEX_HOME` and
socket, `thread/read` the stored thread (expect the last turn `interrupted`), then relaunch the TUI with
`resume <thread> --remote`, and re-send.

Measured end to end, from a graceful stop to both agents having answered a fresh prompt:

```
recover-seconds=20.0            (both agents relaunched; ~8 s of that is the Codex readiness timeout)
claude pane has E2E_CLAUDE: 2
codex pane has E2E_CODEX:  2
total from fault to both answering: +34.6s
```

## Implications for Loom

1. **Herdr owns terminal processes, and it owns them only while it is alive.** Nothing in a pane survives a
   Herdr restart. Loom's durable state must therefore hold, per task: the worktree path, the provider session
   or thread id, the agent kind, the pane's *intended* command line and environment, and the stage. Nothing
   may be inferred from a pane's argv, because after a restore the argv is Herdr's, not Loom's. This is
   already implied by principle 5 ("the UI holds no durable state") — make it explicit for panes too.
2. **Set `resume_agents_on_restore = false` on Loom-managed sessions**, and treat relaunching as coordinator
   work. `packages/adapters/herdr` should own the "quit whatever is there, start what we stored, report the
   session ref" sequence; `packages/core` should treat "task has a session id and no live provider process" as
   a reconcile trigger, and re-running it must be idempotent (principle 2).
3. **Run one Codex app-server per task, as a Loom child process outside Herdr.** It is the difference between
   a turn completing through a Herdr restart and a turn ending `interrupted`. It also keeps the
   `HERDR_PANE_ID` the integration hook pins the thread to correct, and keeps `CODEX_HOME` isolated. A pane is
   the wrong home for it.
4. **Never read status from Herdr for a decision.** `herdr agent status` is title-derived and can stay stale
   indefinitely after a restart, and `herdr agent prompt --wait` inherits that staleness and hangs. The
   owners are `claude agents --json` plus hooks for Claude, and `thread/read` for Codex — which is principle 4
   ("terminals are for humans") applied to Herdr's own status field, not just to terminal text. Loom should
   not call `--wait` at all.
5. **Record the session ref into Herdr instead of waiting for the integration to.**
   `herdr pane report-agent-session --source herdr:codex` works and is the only path that survives a resume.
   The equivalent for Claude is already covered by launching with `--session-id`.
6. **`--settings` is part of a Claude session's identity for Loom.** Losing it silently turns an observable
   session into an unobservable one that still has the right id. Whatever relaunches a Claude agent must
   re-pass it; a reconciler should verify it is in the running argv before calling the task healthy.

None of this contradicts `docs/architecture.md`; it adds the Herdr-restart column to it. The concrete edits
are: Herdr's ownership is scoped to "while the server lives"; the app-server placement rule in 3; and the
"status owner" list in 4.

## Open questions

- `[experimental] pane_history = true` was not tested. It claims to save recent pane screen history across a
  full server restart; whether it also changes what is relaunched is unknown.
- `herdr workspace create --env KEY=VALUE` exists and might survive a restore, which would fix `CODEX_HOME`
  for a relaunched Codex. Not tested — the spike set the variable inside the pane's shell instead.
- Machine restarts and Herdr's own `herdr update --handoff` path were out of scope; both are more violent than
  a SIGKILL and worth their own pass before Phase 1 ships.
- A Claude agent was never observed mid-*permission* prompt across a restart; that state is likely to behave
  like any other mid-turn loss, but it was not measured.
- `claude agents --json` took up to about 5 s to list a relaunched session. The upper bound was not measured,
  and a reconciler that polls it needs one.
- The Codex readiness timeout in `herdr agent start` for a resumed TUI may be fixable with a manifest change on
  Herdr's side; not investigated.

## How to rerun

```sh
cd spikes/05-restart-matrix
npm install                       # ws, for thread-read.mjs
. ./env.sh                        # $SPIKE, session name, socket, scrub()
./server.sh start true            # or false

# one-time fixture: a throwaway repo at $SPIKE/repo, a workspace on it, a Claude
# agent started with --session-id/--settings/--model and a Codex TUI started with
# `--remote`, plus an app-server started from $SPIKE/repo with CODEX_HOME=$SPIKE/home
# and HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID set. Write the ids to
# $SPIKE/claude-session-id and $SPIKE/codex-thread-id.

./snapshot.sh baseline
./fault.sh stop|kill  idle|midturn  true|false  <tag>
./recover.sh both
```

Accept the Claude and Codex trust prompts only for the fixture repo you created. `fault.sh` refuses to signal
any pid whose argv does not contain `--session loom-s05 server`.
