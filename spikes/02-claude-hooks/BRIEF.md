# Spike 02: Claude Code hooks and Herdr prompt delivery

**Agent:** claude · **Timebox:** about 3 hours · **Depends on:** nothing. Read `spikes/README.md` first.

## Why

For Claude Code, Loom learns status from hooks and sends messages to interactive sessions with
`herdr agent prompt`. Both have to be reliable enough to build on. The hooks also must not slow down or break
sessions when Loom's coordinator is down.

## Setup

- **Throwaway repo:** a git repo under `$TMPDIR/loom-spike-02/repo`.
- **Hook server:** a tiny Node HTTP server in this directory that appends every hook payload to a JSONL file, with a
  receive timestamp.
- **Settings file:** registers `http` hooks for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  PermissionRequest, Notification, Stop, StopFailure, SubagentStart, SubagentStop and SessionEnd, all pointing
  at the server (format: https://code.claude.com/docs/en/hooks). Pass it with `claude --settings <file>`, and
  never edit `~/.claude/settings.json`.
- **Start Claude** in a new pane in your workspace:
  `herdr agent start s02-a --kind claude --pane <pane> -- --settings <file> --session-id <uuid> --model haiku`

## Questions

1. **Payloads.**
   - Which fields does each event carry: `session_id`, `cwd`, `transcript_path`, `agent_id`, notification type?
   - Do hooks from `--settings` merge with user-level hooks? Herdr's SessionStart hook in
     `~/.claude/settings.json` should still run; check with `herdr agent get s02-a`.
   - What is the hook latency, from event to receipt?
2. **Status.** Run a scripted scenario: a prompt that needs a permission, one that asks a question, a normal one,
   and one that gets interrupted.
   - From hooks alone, derive: working, needs permission, needs input, idle, errored, ended.
   - At each moment, compare that with `herdr agent get s02-a` and `claude agents --json`.
   - Report disagreements and lag.
3. **Prompt delivery.** Send 100 prompts with `herdr agent prompt s02-a "<text>" --wait`. Vary them:
   - short;
   - multi-line;
   - about 2 KB;
   - about 20 KB;
   - containing quotes, backticks or unicode;
   - starting with `/` or `!`.

   Using the UserPromptSubmit payloads, count how many arrived exactly once and intact. Also check prompting
   while the agent is working (queued or rejected?) and while it's blocked (expect `agent_blocked`).
4. **Interrupt.** Run `herdr agent send-keys s02-a esc` mid-turn. Which hooks fire?
5. **Resume.** Kill the claude process (not Herdr) mid-turn, then run `claude --resume <id>` in a fresh pane.
   - Is the session_id the same?
   - What is the SessionStart source?
   - Is the interrupted turn visible in the transcript?
6. **Coordinator down.** Stop the hook server, and set hook timeouts to 1–2 seconds.
   - Do sessions slow down, show errors, or block? Measure it.
   - This decides whether Loom can safely install its hooks at the user level.
7. **Background sessions.** Start one with `claude --bg`.
   - Check `claude agents --json`, the hooks, `claude logs` and `claude attach`.
   - Is there any supported way to send it a prompt programmatically? Document what you find; don't go deep.

## Deliverable

`FINDINGS.md`, containing:
- the event → status table;
- the prompt delivery success rate;
- the behavior when the hook endpoint is dead;
- a recommendation for how `packages/adapters/claude` should observe and control sessions.
