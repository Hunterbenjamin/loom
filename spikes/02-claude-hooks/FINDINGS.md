# Spike 02: Do Claude Code hooks give reliable status and task correlation? Does `herdr agent prompt` deliver reliably?

Versions: Claude Code 2.1.268 · herdr 0.9.0 · Node 23.6.0 · Python 3.13.1 · git 2.51.2 · macOS (Darwin 25.2.0) ·
model `claude-haiku-4-5-20251001` (`--model haiku`). Run 2026-09-11, 10:45–11:10 UTC.

## Summary

| Question | Result | One-line answer |
|---|---|---|
| 1a. Payload fields | works with caveats | Every event carries `session_id`, `cwd`, `transcript_path`; most carry `prompt_id`. **HTTP hooks are skipped for SessionStart**; it needs a `command` hook. Field names differ from the docs in places. |
| 1b. `--settings` hooks merge with user hooks | works | Herdr's user-level SessionStart hook still ran; `herdr agent get` reported our pre-chosen session ID every time. |
| 1c. Hook latency | works | Hook dispatch → receipt median 4.5 ms (p95 36 ms, n=34). `herdr agent prompt` → UserPromptSubmit median 311 ms (20 KB: 421 ms). |
| 2. Status from hooks | works with caveats | Working, needs permission, needs input, idle and ended are all derivable. **Esc interrupt and a crash fire no hook**, and approving a permission fires nothing until PostToolUse. `claude agents --json` covers all three gaps. |
| 3. `herdr agent prompt` delivery | works with caveats | 89/89 plain-text prompts arrived exactly once, 87/89 byte-identical (tab → 4 spaces, CRLF → LF). Prompts starting with `/word` or `!` are not prompts: they run slash commands or **shell commands**. Blocked → `agent_blocked`; working → accepted and merged into the running turn. |
| 4. Interrupt (Esc) | works with caveats | `send-keys esc` interrupts reliably, but **no hook fires**: no Stop, no PostToolUseFailure. The transcript records `[Request interrupted by user]`. |
| 5. Resume after kill | works with caveats | Same `session_id`; SessionStart `source: "resume"`. No SessionEnd on SIGKILL. The killed turn's prompt is in the transcript, but its in-flight tool call is not. |
| 6. Coordinator down | works with caveats | Refused connection: no slowdown, but a visible `Stop hook error: connect ECONNREFUSED` after every turn. Hung endpoint: about +8 s per tool turn with 2 s timeouts, no visible error. Don't install HTTP hooks at user level. |
| 7. Background sessions | works with caveats | `claude --bg` hooks, `claude agents --json`, `logs` and `attach` all work. `--bg` **ignores `--session-id`**. A running bg session can't be prompted programmatically. A stopped one can, with `claude --bg --resume <id> "<prompt>"` and no other flags. |

## Evidence

Setup: `hook-server.mjs` appends every POST with a receive timestamp. `hooks.settings.json` registers the 11 events from
the brief (plus PostToolUseFailure and PermissionDenied) with `timeout: 2`. `sampler.py` polls `herdr agent get` and
`claude agents --json` every 250 ms and logs changes. `analyze.py` merges hooks, polls and action markers into one
timeline. Sample payloads for every event observed are in `evidence/payload-samples.json`.

### 1. Payloads, merge, latency

**SessionStart over HTTP is skipped.** No SessionStart ever reached the server. With `--debug-file`:

```
[DEBUG] Skipping HTTP hook http://127.0.0.1:47802/hook/SessionStart — HTTP hooks are not supported for SessionStart
[DEBUG] Hooks: HTTP hook POST to http://127.0.0.1:47802/hook/UserPromptSubmit
[DEBUG] Hooks: HTTP hook response status 200, body length 2
```

SessionStart is the only event that logged this. A `command` hook (`curl … --data-binary @- …; exit 0`) delivered it on every
start (`startup`, `resume`, `fork`), about 0.9 s after launch.

**Fields per event.** `session_id`, `transcript_path` and `cwd` are on every event. Event-specific fields:

```
SessionStart:startup        model, scratchpad_dir, source
SessionStart:resume|fork    source, context_tokens, estimated_cache_write_usd, prompt_cache_likely_expired, seconds_since_last_response
UserPromptSubmit            permission_mode, prompt, prompt_id, scratchpad_dir
PreToolUse                  permission_mode, prompt_id, tool_input, tool_name, tool_use_id
PermissionRequest           permission_mode, permission_suggestions, prompt_id, tool_input, tool_name   (no tool_use_id)
PostToolUse                 duration_ms, prompt_id, tool_input, tool_name, tool_response, tool_use_id
Notification                message, notification_type (seen: permission_prompt, idle_prompt), prompt_id
Stop                        last_assistant_message, stop_hook_active, background_tasks, session_crons, prompt_id
SubagentStop                agent_id, agent_type (""), agent_transcript_path, prompt_id
SessionEnd                  reason (seen: prompt_input_exit for /exit, other for -p), prompt_id
```

- The docs say UserPromptSubmit carries `user_prompt`; 2.1.268 sends **`prompt`**. The docs also list `tool_calls_this_turn` and
  `did_tool_use` on Stop; they are **absent**.
- `agent_id` appears only on subagent events.
- An internal subagent (`agent_type: ""`) fires **SubagentStop on most turns, with no SubagentStart**. SubagentStart never
  fired in this spike.
- `cwd` is the **realpath**: `$TMPDIR` is `/var/folders/…`, but hooks, `herdr agent get` and `claude agents --json` all
  report `/private/var/folders/…`.
- StopFailure, PostToolUseFailure and PermissionDenied never fired.

**Merge.** Herdr's user-level `~/.claude/settings.json` SessionStart hook kept working alongside `--settings`, in 6 of 6 launches:

```
$ herdr agent get s02-a   →  "agent_session":{"source":"herdr:claude","value":"6d3b4239-0b4f-4c87-97c5-ee6146088430"}   (= our --session-id)
```

`--settings` hooks fired **before** the workspace-trust dialog was accepted: SessionStart arrived 3.8 s before trust was granted.

**Latency.** Claude's own `HTTP hook POST` debug timestamp → server receive: n=34, median 4.5 ms, p95 36 ms, max 52 ms.
`herdr agent prompt` invoked → UserPromptSubmit received: prompts under 5 KB n=79, median 311 ms, p95 322 ms; 20 KB prompts
n=10, median 421 ms. Herdr trails the hooks by about 0.3–0.5 s (sampled every 250 ms). `claude agents --json` flips with
the hook or slightly **before** it.

### 2. Status: scripted scenario (`scenario.sh`)

The scenario ran four turn types: permission (`touch`), question (AskUserQuestion), a normal turn, and interrupted turns. Trimmed `analyze.py`
timeline (seconds; `derived` is the status computed from hooks alone):

```
66.105 hook UserPromptSubmit                                derived=working
66.596 poll herdr=working   claude=busy
69.134 poll herdr=working   claude=waiting        ← claude agents sees the permission before the hook
69.246 hook PreToolUse        Bash                          derived=working
69.256 hook PermissionRequest Bash                          derived=needs_permission
69.640 poll herdr=blocked   claude=waiting        ← Herdr +0.38 s
75.272 hook Notification      permission_prompt   ← 6.0 s after PermissionRequest
~84.0  (approve: send-keys enter)
84.084 poll herdr=blocked   claude=busy           ← no hook for "approved"
85.033 hook PostToolUse       Bash                          derived=working
86.328 hook Stop                                            derived=idle
86.625 poll herdr=idle      claude=idle           ← Herdr +0.30 s
```

- **AskUserQuestion** arrives as `PreToolUse` + `PermissionRequest` with `tool_name: "AskUserQuestion"`, then a `permission_prompt`
  Notification 6 s later. The answer arrives only in `PostToolUse.tool_response`. `claude agents` and Herdr can't tell it apart
  from a permission prompt (`waiting` / `blocked`).
  - Note: this dialog was answered at the pane by a person watching, 105 s after it was asked, not by the script. The
    script's Enter landed on an idle prompt. The hook sequence is unaffected.
- **Approval gap.** Approving `sleep 6 && touch gap.txt` left hook-derived status at `needs_permission` for **6.1 s**,
  until PostToolUse. `claude agents` said `busy` 0.1 s after approval.
- `Notification: idle_prompt` fires about 60 s after a Stop.

Event → status table, as used in `analyze.py`:

| Status | Enter on (hooks) | Leave on | `herdr agent get` | `claude agents --json` |
|---|---|---|---|---|
| working | UserPromptSubmit, PreToolUse (tool ≠ AskUserQuestion), PostToolUse(Failure), PermissionDenied | Stop, PermissionRequest | `working` (+0.3–0.5 s) | `busy` |
| needs permission | PermissionRequest (tool ≠ AskUserQuestion); Notification `permission_prompt` confirms 6 s later | PostToolUse / PostToolUseFailure / PermissionDenied. **Nothing fires on approve.** | `blocked` | `waiting` |
| needs input | PreToolUse / PermissionRequest with `tool_name == "AskUserQuestion"` | PostToolUse (AskUserQuestion) | `blocked` | `waiting` |
| idle | Stop; SessionStart; Notification `idle_prompt` | UserPromptSubmit | `idle` / `done` | `idle` |
| errored | StopFailure (not triggered in this spike) | UserPromptSubmit | – | – |
| ended (clean) | SessionEnd | SessionStart `resume` | `agent_not_found` | entry gone |
| interrupted (Esc) | **no hook** | – | `idle` in ≤0.25 s | `idle` at once |
| crashed (SIGKILL) | **no hook** | – | `agent_not_found` | entry gone |

Disagreements seen:
- Herdr can't separate *permission* from *question*.
- Herdr keeps showing `blocked` for about 0.3 s after an approval, and `working` for about 0.3 s after a Stop.
- Hooks can't see an interrupt, a crash, or the moment of approval.

### 3. Prompt delivery (`prompts.py`, 100 prompts to a fresh session `s02-b`, one run)

```
TOTAL exactly-once-intact: 87/100   UserPromptSubmit payloads in session: 89
short 20/20 · multiline 20/20 · 2kb 15/15 · 20kb 10/10 · special 18/20 · slash-path 4/4 · slash-word 0/5 · bang 0/6
P075 special: "a\ttab\tseparated"   → "a    tab    separated"   (tab → 4 spaces)
P076 special: "line one\r\nline two" → "line one\nline two"      (CR dropped)
```

- **Delivery.** All 89 plain-text prompts arrived **exactly once**: no duplicates, no losses. 20 KB prompts arrived in full in
  `prompt`, not as a "[Pasted text]" placeholder. Quotes, backticks, `$(…)`, emoji and ZWJ sequences, CJK, RTL, combining
  marks, zero-width and NBSP characters all arrived byte-identical.
- **`/p085x …` (5/5).** The transcript records `system informational "Unknown command: /p085x"`. There was no
  UserPromptSubmit and no turn, and Herdr returned `agent_prompt_stalled` after 5 s. `/tmp/p081/file.txt …` was delivered
  as a normal prompt (4/4).
- **`!echo p094-bang` (6/6).** This ran **as a shell command in bash mode**: `<bash-input>echo p094-bang</bash-input>`, then
  `<bash-stdout>`. It raised no UserPromptSubmit, and Claude then commented on the output. Herdr returned `idle`.
- **Prompt while blocked.** Rejected before any input was sent:
  `{"error":{"code":"agent_blocked","message":"agent s02-a is blocked and requires interactive input"}}`.
- **Prompt while working** (4 s into a `sleep 15` tool call).
  - Herdr **accepted** it, and UserPromptSubmit fired **at once**, while the tool was still running.
  - Claude merged it into the running turn. The reply was `"slept\n\nqueued-ok"` with **one Stop**.
  - The second UserPromptSubmit carried the **same `prompt_id`** as the running turn (`e6dd3ff8…`), so `prompt_id` identifies a
    turn, not a prompt.
  - `--wait` returned when that turn ended.
- **Timing.** Per-prompt round trip with `--wait` was about 1.6 s for a trivial reply.

### 4. Interrupt

These were run once each. A standalone `sleep 30` is refused by Claude Code itself
(`Blocked: standalone sleep 30. To wait for a condition, use Monitor…`), so the interrupt used `sleep 15`.

```
Esc during Bash `sleep 15`:   hooks: UserPromptSubmit, PreToolUse …then nothing.   claude=idle at 4.670 s, herdr=idle at 4.922 s
Esc while streaming text:     hooks: UserPromptSubmit …then nothing.               claude=idle at 11.014 s, herdr=idle at 11.268 s
Next prompt:                  normal UserPromptSubmit → Stop
Transcript:                   user [{"type":"text","text":"[Request interrupted by user]"}]
Screen:                       ⎿  Interrupted · What should Claude do instead?
```

No Stop, PostToolUse, PostToolUseFailure or Notification fired. PostToolUseFailure was registered in the settings file,
but was added mid-session. It was also absent from the resumed session, which loaded it at startup.

### 5. Resume after kill

`kill -9 <pid of our session from claude agents --json>` was sent 4 s into a `sleep 15` tool call. It was run once.

```
hooks after kill:     UserPromptSubmit, PreToolUse(Bash) — no PostToolUse, no Stop, no SessionEnd
herdr agent get:      {"error":{"code":"agent_not_found",…}}   (Herdr released the name)
claude agents --json: []                                       (entry gone)
herdr agent start s02-r … -- --settings … --resume 6d3b4239-… --model haiku   (fresh pane)
SessionStart          session_id 6d3b4239-… (same)  source "resume"   transcript_path unchanged
herdr agent get s02-r agent_session.value 6d3b4239-… (same)
transcript tail:      user "Use the Bash tool to run: sleep 15 …"  →  bridge-session   (no tool_use, no interruption marker)
```

The resumed screen shows the killed prompt with no answer. PreToolUse had fired for the Bash call, but the transcript never
got the assistant `tool_use` message, so the in-flight tool call is lost.

### 6. Coordinator down (`q6.sh`)

Separate session `s02-c`, every hook `timeout: 2`, SessionStart as a `curl -m 1 …; exit 0` command hook. Each turn was
"run `sleep 1`, reply done" (UserPromptSubmit, PreToolUse, PostToolUse, Stop). Results from `evidence/q6.jsonl`:

| Endpoint | Turn (send → idle) | Visible in the UI | `/exit` | Startup |
|---|---|---|---|---|
| up | 5.9 / 4.5 / 4.5 / 5.1 s | nothing | 1.9 s | 3.6 s |
| down (connection refused) | 4.3 / 4.2 / 4.2 / 5.9 s | `⎿ Stop hook error: connect ECONNREFUSED 127.0.0.1:47803` after each turn | 1.8 s | 3.7 s |
| hung (accepts, never replies) | 12.8 / 12.6 / 12.3 s | nothing (debug log only: `Hook PreToolUse:Bash (PreToolUse) cancelled`) | 3.8 s | 3.6 s |

- A dead endpoint costs nothing in time, but shows the user an error after each turn.
- A hung endpoint **blocks every hook for its full timeout**: 4 hooks × 2 s ≈ +8 s per tool turn.
  - The default HTTP timeout is 600 s (30 s for UserPromptSubmit), so a stuck coordinator with default timeouts would freeze sessions for minutes.
  - SessionEnd honoured the 2 s timeout on `/exit`.
- The `exit 0` SessionStart command hook never showed an error in any state.

### 7. Background sessions

```
$ claude --bg --settings hooks.settings.json --model haiku "Reply with just: ok"
backgrounded · 3ceeb489
$ claude agents --json   → {"id":"3ceeb489","sessionId":"3ceeb489-6eda-…","kind":"background","status":"idle","state":"done","pid":86722,…}
hooks                    → SessionStart(startup) · UserPromptSubmit · Stop   (cwd = the bg repo, not a new worktree)
$ claude --bg --session-id <uuid> …
warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)
$ claude --bg --resume 3ceeb489-… --settings … "Reply with just: second"      (session running)
note: session 3ceeb489 is already running in the background, so this started a copy as 9eed8c1d.   → SessionStart source "fork"
$ claude stop 3ceeb489; claude --bg --resume 3ceeb489-… --settings … "…fourth"   (stopped, with flags)
note: background session 3ceeb489 keeps its own saved options, so the flags you passed started a copy as edd6458d.
$ claude stop 3ceeb489; claude --bg --resume 3ceeb489-… "Reply with just: sixth" (stopped, no flags)
note: woke session 3ceeb489 with its saved options (--settings, --permission-mode, --model).
backgrounded · 3ceeb489   → SessionStart(resume, same id) · UserPromptSubmit · Stop
$ claude logs 3ceeb489   → raw ANSI screen bytes (cursor moves, spinner frames)
$ claude attach 3ceeb489 (in a Herdr pane) → full TUI; Herdr sees agent=claude, agent_session=None; attaching wakes a stopped session
```

The only programmatic prompt path is the last `--resume` form: stop the session, then resume it with a prompt and no flags.
It restarts the process each time. There is no supported way to send a prompt to a *running* bg session.

## Implications for Loom

Changes to `docs/architecture.md` (Agent integration, Observe and Control rows for Claude Code):

1. **Observe = hooks as hints + `claude agents --json` as the status owner.**
   - Hooks carry the detail: session_id, prompt_id, tool, question vs permission, answers, `last_assistant_message`.
   - `claude agents --json` (`busy` / `waiting` / `idle`, plus presence and pid) is the only source that sees Esc, crashes
     and approvals. Poll it on every hook, and every 1–2 s while a Loom-launched session is `busy` or `waiting`.
   - Herdr's status is a fallback only.
2. **SessionStart must be a `command` hook.** Drop it from the HTTP hook list; forward it with `curl … || true; exit 0`.
3. **Turn correlation uses `prompt_id`, not UserPromptSubmit/Stop pairs.** Several prompts can share one turn and one Stop.
   Don't assume one prompt, one turn.
4. **Status reducer rules:**
   - AskUserQuestion (via PreToolUse or PermissionRequest) → *needs input*. Any other PermissionRequest → *needs permission*.
   - Ignore subagent events whose `agent_type` is empty.
   - Don't wait for Notification `permission_prompt`; it lags by 6 s.
5. **Join key: `realpath()` the worktree path** before storing or comparing it. `/var` and `/private/var` differ on macOS.
6. **Failure detection.**
   - A crash gives no SessionEnd; detect it as "`claude agents` entry vanished without SessionEnd".
   - Resume with `claude --resume <id> --settings <loom-settings>`. `--settings` must be passed again for interactive sessions.
   - Expect the in-flight tool call to be missing from the transcript.
7. **Hook installation.** Install hooks **per session via `--settings`** for Loom-launched runs:
   - HTTP, `timeout: 1`, SessionStart as a command hook.
   - **Don't install HTTP hooks at user level.** A dead coordinator shows an error after every turn in every session, and a
     hung one adds the timeout to every hook.
   - Hand-started sessions don't need user-level hooks to be found: `claude agents --json` already lists every interactive
     session with `cwd` and `sessionId`.
8. **Control (interactive): `herdr agent prompt` is reliable for text,** with some rules:
   - The adapter must **refuse or escape prompts starting with `/` or `!`**, because `!` runs a shell command without a permission prompt.
   - Expect tabs and CR to be normalized.
   - Treat `agent_blocked` as "surface the dialog to the human".
   - Don't treat `--wait` as turn completion; use Stop plus `claude agents`.
   - Interrupt with `herdr agent send-keys esc`, and confirm through `claude agents` (`idle`), not hooks.
9. **Principle 7 vs `claude --bg`.** `--bg` can't take a pre-chosen session ID, and running bg sessions can't be prompted.
   Loom-launched interactive runs should stay in Herdr panes with `--session-id`, and headless roles should use the Agent SDK
   or `-p`, as planned. Treat `--bg` sessions found in `claude agents` as observe-only.
10. **Trust dialog.** A new worktree shows the workspace-trust dialog. `herdr agent start` returns `agent_not_ready`, and the
    default choice is "No, exit", so a blind Enter kills the session. Loom has to handle this before prompting (see Open questions).

## Open questions

- **StopFailure → errored** is untested: no cheap way to cause an API error mid-turn. Try an invalid model or a revoked
  token in an isolated run.
- **Pre-trusting worktrees** without editing `~/.claude.json`. Does trust on a parent directory (for example Herdr's
  worktrees root) cover new worktrees? Otherwise the adapter must detect the dialog and ask the human.
- **Command-hook overhead.** Spawning `sh` + `curl` per event wasn't measured. That matters if Loom switches every event to
  command hooks, for example writing to a spool file so events survive a coordinator restart.
- Is there an `async` / fire-and-forget option for HTTP hooks, so a hung coordinator costs nothing?
- Does a leading space or another prefix safely neutralize `/` and `!` in `herdr agent prompt` text?
- Does `--settings` hot-reload in a running session? PostToolUseFailure and PermissionDenied were added mid-run, but
  neither event was triggered, so this is inconclusive.
- `claude agents --json` status values seen: `busy`, `waiting`, `idle`, plus `state: done` for bg sessions. The full enum is unknown.

## How to rerun

Needs Herdr (`HERDR_ENV=1`), Claude Code logged in, Node and Python. Run from `spikes/02-claude-hooks/`:

```sh
B=$TMPDIR/loom-spike-02; mkdir -p $B/repo $B/bulk && (cd $B/repo && git init -q) && (cd $B/bulk && git init -q)
node hook-server.mjs 47802 $B/hooks.jsonl &                                   # hook sink
P=$(herdr pane split --current --direction right --cwd $B/repo --no-focus | jq -r .result.pane.pane_id)
herdr agent start s02-a --kind claude --pane $P -- --settings $PWD/hooks.settings.json --session-id $(uuidgen | tr A-Z a-z) --model haiku
#   (accept the trust dialog if shown: herdr agent send-keys s02-a down enter)
python3 sampler.py s02-a loom-spike-02/repo $B/status.jsonl &                 # status poller
sh scenario.sh step1 && sh scenario.sh                                        # Q2–Q4 (answer dialogs as prompted)
python3 analyze.py $B <session-id>                                            # merged timeline + derived status
# Q3: start s02-b the same way in $B/bulk, then
python3 prompts.py run s02-b && python3 prompts.py check <s02-b session-id>
# Q6: node hook-server.mjs 47803 $B/hooks-q6.jsonl &; start s02-c with hooks-q6.settings.json in pane $(cat $B/PANE_C); sh q6.sh
# Q7: see the commands in Evidence §7.
```
