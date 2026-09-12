# Phase 2: `packages/adapters/claude`

**Agent:** claude, Opus · **Branch:** `feat/adapter-claude` · **PR title:** "Phase 2: Claude adapter".
Read [`phase-2-common.md`](phase-2-common.md) first, then spike 02's findings and its `hook-server.mjs`
and settings files.

## Build

Implement `ClaudeAdapter` from `packages/core/src/adapters.ts`.

- `listSessions`: `claude agents --json`, validated, as `ClaudeAgentsEntry[]`. This is the owner of
  live status. Note the design's `unknownGraceMs` must exceed the up-to-5-second lag spike 05 saw
  for a relaunched session.
- **Hook receiver:** a local HTTP endpoint that stores every hook payload as a receipt (the design's
  `claude_hooks` log, in memory here with a persistence interface the store can implement later), and
  `hookSummary` that folds them into `ClaudeHookSummary`: pending dialog from PreToolUse or
  PermissionRequest (AskQuestion means `input`, anything else `permission`), prompt submits with
  normalized-text hashes, last Stop, StopFailure, SessionStart and SessionEnd. Ignore subagent events
  with an empty `agent_type`.
- **Per-run settings file generator:** `interactiveArgs` and `startHeadless` take a settings path; add
  a function that writes it: HTTP hooks with `timeout: 1` for every event except SessionStart, which
  must be a `command` hook (HTTP is skipped for it), plus Loom's MCP server entry. Never write to
  `~/.claude/settings.json`.
- `startHeadless`, `sendHeadless`, `interruptHeadless`, `headlessState`: over the Agent SDK
  (`@anthropic-ai/claude-agent-sdk`), with Loom choosing the session ID and `resume` for retries.
- Add a resumability check (does the transcript for that session ID exist and parse) and an activity
  timestamp source from hooks, for the design's `resumable` and `activityAt`. Contract changes.
- `subscribe`: hook receipts become hints.

## Tests

Unit tests post recorded hook payloads (spike 02's `payload-samples.json`) to the receiver and check
the folded summary, the settings file contents, and `listSessions` parsing including the `other`
status fallback. Opt-in real tests start one headless session with `--model haiku` and a trivial
prompt.

## Out of scope

Herdr, prompting interactive sessions (that's the Herdr adapter), and the trust dialog.
