# Loom architecture

Terminology: an “issue” in the UI is a “task” in the code; internal identifiers and MCP tool names retain `task`.

This is the baseline design from 2026-09-11. Anything marked *(spike NN)* is an assumption that spike has to confirm.

## Goal

One fast place to:
- create issues;
- watch agents work on them;
- step into their terminals;
- review and approve the results.

GitHub, tmux, Codex and Claude Code keep working on their own, and anything done directly in them
shows up in Loom.

## Workflow

```
Backlog →(human) Todo →(auto) Planning →[valid plan] (optional plan approval) → In progress
→[submit_for_review + commits] In review →[explicit reviewer escalation, round < 3] In progress
                                         →[inline fixes committed, no blockers, reviewed head published] Awaiting approval
→[human approves head SHA, CI green] Merging →[PR merged on GitHub] Done
```

Issues can also be Canceled. Three things are tracked separately and must not be merged:
- the **issue stage** (the board column);
- the **agent run status** (working, idle, blocked, failed);
- **attention**: whether the issue needs the human right now.

## Components

The window's two modes (Tracker and Workbench), the multi-window model, and what the protocol must
carry for them are in [`docs/design/ui.md`](design/ui.md).

```
┌──────────── Dashboard (Electron renderer) ────────────┐
│ Linear-style UI · embedded terminals · diff review    │  no durable state
└──────────────▲ snapshot + patches over a local WebSocket
┌──────────────┴── Coordinator (launchd agent, Node/TS) ─────────────┐
│ SQLite (WAL) · reconciler · stage rules · run supervisor           │
│ MCP server for agents · adapters: git, GitHub, tmux, Codex, Claude  │
└──┬──────────────┬──────────────┬──────────────┬────────────────────┘
 GitHub     Codex daemon   Claude processes  tmux server ── any number of
                                             (-L loom-<instance>)  attached clients
```

## Ownership

| Fact | Owner | Loom's copy |
|---|---|---|
| Issue fields, stage, plans, findings, test results, approvals, run records | Coordinator (SQLite + artifact files) | Authoritative |
| Branches (including PR head existence), PRs, CI, reviews, merge state | GitHub / local git | Cache with fetch time; repository PR lists, readiness counts derived from them, and subscribed detail/patch projections are disposable, including PRs without issues |
| Diffs | The worktree or the PR | Computed on demand |
| Session transcripts and live status | Codex daemon / Claude Code | Cache + references |
| Terminal processes | tmux, only while its server is alive | References (`{hostGeneration, sessionName, windowId, paneId}`), plus each run's intended command line and environment, so Loom can relaunch it. Pane IDs restart at `%0` after a server death, so every ref is scoped to a host generation |

Done is derived from GitHub: an issue is Done only once its PR is merged.

## Settings ownership and inventory

The coordinator owns versioned instance defaults and sparse repository overrides in SQLite. The
precedence is: explicit task-creation value, environment override, repository value, global value,
built-in default. Task workflow policy is captured at creation; provider/model/reasoning/mode/access
is captured on each run. Retries and recovery retain that recipe, while an explicit restart uses the
current effective role profile. Live supervisor values apply immediately; the catalog labels values
that apply to the next task, next run, or coordinator restart. Every stored mutation uses an expected
version and appends a redacted audit row. Settings and audit schemas reject secret-bearing keys.
At startup the coordinator opens the store with bootstrap defaults, resolves the global settings
row, refreshes core's reconcile configuration, and only then constructs tool and GitHub adapters.
Immediate changes replace the live reconcile configuration and reschedule affected supervisor
timers; resetting a value re-resolves from the immutable startup/environment baseline. Provider-wide
model environment variables are applied after each role's effective provider is selected, so a
repository provider override cannot detach or misapply them.

This is the reviewed production configuration inventory. “Exposed” means it is represented by the
typed catalog and Settings page; environment-backed rows are visible but disabled while the variable
is present.

Repository scope is intentionally limited to role profiles, task/workflow defaults, base branch and
serialized tests. Capacity, retry/polling, executable paths, Main, GitHub observation and
desktop presentation are single-supervisor or single-instance facts and are editable only at Global
defaults; repository documents show them as inherited and disabled. Existing `Repo.defaultProviders`
remain the per-role compatibility baseline until that exact role field is overridden, so one sparse
edit cannot reroute the other roles.

| Configuration | Current code owner/location | Classification |
|---|---|---|
| Planner, implementer and reviewer provider (`LOOM_PROVIDER_*`), provider model (`LOOM_MODEL_CODEX`, `LOOM_MODEL_CLAUDE`), Codex reasoning (`LOOM_CODEX_REASONING_EFFORT`), `LOOM_RUN_MODES`, semantic `LOOM_AGENT_ACCESS` | `apps/coordinator/src/config.ts`, `packages/core/src/settings.ts`, run recipe and provider launch adapters | Exposed; next run. Planner read-only remains a fixed floor. |
| Plan approval, size, budget, review-round cap, merge policy | create-task protocol/CLI and `packages/core` task policy | Exposed; captured on the next task. Explicit creation values win. |
| Repository base branch, default providers and serialized-test flag | `packages/core` `Repo`, `apps/coordinator/src/repos.ts` | Exposed in the Repositories and role sections at global/repository scope; repository identity/root remains registration-owned. |
| Main model (`main.model`, `LOOM_MODEL_LEAD`) | `apps/coordinator/src/lead.ts`, `config.ts` | Exposed in Main; next run. |
| Capacity, retry base/cap/attempts, stall/unknown/delivery timeouts, GitHub task poll, resync and heartbeat | `apps/coordinator/src/config.ts`, loop/executor/observation | Exposed in Advanced runtime; immediate except heartbeat, which needs restart. |
| Worktree root and tmux/Codex/Claude executables (`LOOM_WORKTREE_ROOT`, `LOOM_TMUX`, `LOOM_CODEX`, `LOOM_CLAUDE`) | coordinator config and launch adapters | Exposed; restart required. |
| GitHub excluded authors (`LOOM_EXCLUDED_AUTHORS`) | coordinator observation/config | Exposed; immediate. |
| Theme, chime, startup window (`LOOM_WINDOW_MODE`), terminal history, key prefix/timeout and bindings | desktop renderer/main and coordinator settings | Exposed as instance-wide appearance/terminal defaults. The renderer imports `keybindings.json` only when those stored fields are absent, then main uses coordinator updates and keeps a derived private startup cache for the next Electron launch. |
| `LOOM_INSTANCE`, `LOOM_DATA_ROOT` | process bootstrap before SQLite opens | Deliberately not exposed: instance identity/storage cannot move from a connected client. |
| `LOOM_BIND`, `LOOM_MCP_PORT`, `LOOM_HOOK_PORT` | protocol/MCP/hook bootstrap | Deliberately not exposed: live edits would strand clients and runs. |
| `LOOM_TOKEN`, `LOOM_MCP_TOKEN`, provider/GitHub credentials | protocol auth and private per-run recipes | Deliberately not exposed. Only configured/not-configured readiness leaves the coordinator. |
| Repository root/GitHub identity; provider session IDs and private recipes | repository registration; provider/runtime owners | Deliberately not exposed as preferences. |
| Shell, PATH, HOME, locale; WORKFLOW commands and fixed safe command allowlists; Main MCP boundaries; tmux isolation/status/mouse/resize/remain-on-exit behavior | process environment, workflow file, adapters | Deliberately not exposed: identity, security and observability invariants. |
| `LOOM_TASKS`, `LOOM_WIDTH`, `LOOM_HEIGHT`, `LOOM_ATTACH_PANE`, `LOOM_TMUX_BIN`, `LOOM_EXIT_WHEN_INTERACTIVE`, `LOOM_REAL_PROVIDERS`, `LOOM_TEST_SLOW_GIT` | fixture/performance/test scripts | Out of scope: non-production controls. |
| `LOOM_AGENT_EXEC`, `LOOM_ATTACH_AGENT`, `LOOM_NAMESPACE`, `LOOM_TMUX_CONF` | standalone `scripts/agent.sh` workflow | Out of scope: the independent development launcher is not coordinator configuration. |
| Adapter command/paste/reconnect/process-owner timeouts, patch/frame/page caps and test loop caps | adapter/protocol implementation constants | Out of scope until a measured production requirement promotes one into the catalog. |

Automatic merge policy never bypasses the merge path. `auto-small` applies only to captured small
tasks and `auto-all` to every task. Core creates a policy-attributed exact-head approval only after
the reviewer published that head, blocking findings are clear, CI for that head is successful (or
has no checks) and fresh, and GitHub reports the PR open and mergeable. Any changed head/findings,
failed or stale guard, failed merge precondition, or recovery observation voids that approval.

## Synchronization

- **Reconcile from current state.** Every event enqueues `reconcile(taskId)`: hooks, app-server
  notifications, pane-host hints, and changes found by polling GitHub. Reconcile re-reads from each owner,
  compares that with the desired state, and takes idempotent actions. A full resync runs about every 60 seconds.
- **One reconcile at a time per issue.** Stage transitions are compare-and-set on a version column
  and are logged in a `transitions` table.
- **Join key: the worktree path.**
  - Claude hooks, Codex threads, tmux panes and `claude agents --json` all report their working directory (`cwd`).
    A pane's `pane_start_path` survives its process, so a dead pane still joins to its issue.
  - Compare real paths: macOS reports the same folder as both `/var/…` and `/private/var/…`.
  - A branch maps to its PR.
  - Sessions started by hand inside an issue's worktree attach to that issue.
  - Any other session goes to an Unassigned inbox.
- **Actions taken outside Loom:**

  | Action | Result |
  |---|---|
  | PR merged | Done |
  | PR closed | Ask whether to cancel |
  | New commit after approval | Approval is void; back to In review |
  | Human PR comments | Imported as findings |
  | Typing into an agent's terminal | Shows as activity only |
  | Moving a card while an agent is running | The coordinator interrupts the run |
- **GitHub:** poll because webhooks can't reach localhost. Repository PR lists use one GraphQL
  request including check/review/mergeability summaries every 60 seconds while a window subscribes
  to that repo/state (cursor pagination above 100 rows, capped at 1,000 pages). GraphQL has no ETag;
  compare mapped rows and preserve unchanged observations so identical refreshes publish no patch.
  Reviews list/detail summaries include GitHub viewer authorship, outstanding viewer review
  requests, required-review status and completion time. These are disposable owner facts used
  for inbox grouping; the renderer never guesses the human identity from a local Git author.
  First snapshots use cached rows immediately with an initial loading flag, then receive patches.
  Reads run concurrently across scopes, with at most one in flight per key.
  Each window subscribes to its selected repository's open list for the bottom-bar readiness count
  in both Tracker and Workbench; other list states are subscribed only while visible. GraphQL
  detail (including remote head-branch existence) and capped REST compare diffs refresh every 30 seconds while the PR is open in a window. Identical
  scopes share one poll, and disconnect/unsubscribe cancels it when the last viewer leaves.
  PR commands run through the executor, always refresh their owner after success or failure, and
  invalidate linked issues' observations. Failed reads retain the last good projection and read time.
  A detail read publishes the overview immediately; its matching diff arrives in a second patch.
  The diff is an immutable REST `compare/<baseSha>...<headSha>` request: GitHub's diff media
  response has no head SHA, so consistency uses the requested SHAs and the GraphQL observation,
  never an ETag as a commit identity. Cached list SHAs let both requests start together; a direct
  uncached open reads detail first. A stale list range is discarded and the new range fetched.
  Detail content and diffs are disposable caches scoped to PR/head/base. Unchanged polls select
  only live metadata and check runs; a push, base change or edited PR invalidates content. Explicit
  refresh and actions force fresh content. Failed diffs retain the readable overview with a retry
  error, never a mismatched patch. Snapshot rows and their sequence are captured synchronously,
  so an early detail/diff patch cannot be overwritten by an older snapshot. Every
  list/detail/check/diff read logs its elapsed milliseconds.

## Agent integration

Each provider has four channels:

| Channel | Codex | Claude Code |
|---|---|---|
| **Control** | App-server over a unix socket: `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`; the coordinator answers approval requests. | Headless roles: Agent SDK or `claude -p --output-format stream-json`. Interactive: the pane host's `pasteText` (refusing text that starts with `/` or `!`), and `sendKey Escape` to interrupt. |
| **Observe** | App-server notifications: `turn/*`, `item/*`, `turn/diff/updated`, `turn/plan/updated`, `account/rateLimits/updated`. | `claude agents --json` owns live status (`busy`, `waiting`, `idle`). Per-session hooks from `--settings` add detail: HTTP for most events, a `command` hook for SessionStart. The pane host supplies no status at all. See [Claude Code](#claude-code). |
| **Attach** | A tmux pane running `codex resume <thread> --remote unix://…` against the coordinator's server. Concurrent attach verified on 0.154.0; see [spike 01 findings](../spikes/01-codex-shared-thread/FINDINGS.md). | A tmux pane; "take over" a headless run with `claude --resume <id>`. For the in-app view, see [Embedded terminals](#embedded-terminals). |
| **Signal** (agent → Loom) | Loom MCP tools | Loom MCP tools |

The Loom MCP tools are `get_task_context`, `submit_plan`, `report_progress`, `ask_human`,
`submit_for_review`, `submit_review(findings)` and `resolve_finding`. Their inputs are validated
against a schema before any transition.

Rules:
- Choose and record the session ID before launch: `claude --session-id <uuid>`, or the Codex thread ID
  returned by `thread/start`.
- All roles (planner, implementer, reviewer) run interactively by default for visibility in panes.
  Override per-role modes via `LOOM_RUN_MODES` (for example,
  `planner=headless,reviewer=headless`). The setting is captured only when a new run row is created;
  existing runs, retries, resumes, and externally discovered sessions retain their recorded mode.
  Planners retain their role restrictions in both modes: Codex uses the read-only sandbox;
  Claude disallows Edit, Write and NotebookEdit. Reviewers use the implementer launch permissions
  in both modes so they can edit and commit inline. Claude's tool restrictions are not a filesystem sandbox.
  Codex clients can share a live thread on the same app-server. Resume to subscribe, hydrate current state, then reconcile
  notifications. Use `turn/steer` with `expectedTurnId` for mid-turn input.
- Codex approval requests reach all subscribed clients, including a client resuming while a request
  is pending. Either client can answer; clear the prompt on `serverRequest/resolved`. Scope pending
  request IDs to the server connection generation, since IDs restart after a server restart.
- Codex `thread/status/changed` supplies `active`, `idle`, `systemError`, and `notLoaded`, with
  `waitingOnApproval` and `waitingOnUserInput` flags. Re-read current state; preserve the distinction
  between the last turn's outcome and whether the thread is currently executing. A disconnected
  observer has unknown live status, not proof of failure. A rate-limit update triggers a fresh
  snapshot; receiving an update alone does not mean the provider is blocked.
- Plain Codex without `--remote` used an embedded runtime in spike 01. Another server sharing its
  data directory could discover/read its transcript, but reported `notLoaded` and synthesized
  `interrupted` for a still-running unfinished turn. Do not resume it concurrently through a different
  server or derive live status from that disk view. Require an explicit handoff before control.
  Claude's headless-to-terminal handoff remains exclusive, pending its own spike.
- Provider choice is a rule the human can override; the planner may suggest one. The default routing
  follows both cost and quality: planners and reviewers on Claude (Opus, or Fable for planning),
  quality-critical implementation on Claude, and bulk or tightly specified implementation on Codex,
  whose budget is larger. Review is cross-provider wherever it can be, so a second model reads the
  first one's work. Name the model explicitly when launching a run; never rely on a tool's default.
- The pane host has no agent awareness, and must never be given any. It reports native pane facts
  only: pid, foreground command name, `pane_dead`, exit status, start path. Loom owns the link from a
  pane to a run, and records it before launch (principle 7).
- Run one Codex app-server per issue as a Loom child process, never in a pane. Outside the pane host a
  mid-flight turn completes through a host restart; in a pane it ends interrupted (spike 05).
  On coordinator recovery, reconnect to the issue's private socket and verify the reported
  `CODEX_HOME`. Persist its PID and process birth time in the private issue directory; verify both
  birth time and the exact issue socket in its command before signaling a recovered process.
  Pre-pidfile servers are identified with a query scoped to that socket. Reap a verified stale
  owner before replacing its record only when an immediate store query finds no unended Codex run
  with a recorded session for that task. Re-check that ownership and the PID birth/socket identity
  immediately before every recovery signal. A live session refuses recovery and emits a
  task-correlated diagnostic; refuse a foreign home or a non-socket path. Explicit shutdown
  terminates adopted servers as well as children. Never discover or signal the shared daemon.
- A pane is not evidence of a session. `pane_current_command` was `2.1.269` for Claude and `node` for
  Codex's launcher, and cwd identifies the issue, not the session (spike 06 §4). Reject an ambiguous
  match instead of guessing.
- `--settings` is part of a Claude session's identity. Whatever relaunches a Claude agent must pass it
  again; a session running without it is unobservable even though it has the right ID.

### Main session

The coordinator also owns one interactive Claude Main session per repository, outside the issue/run
model. Its recipe, credentials, settings and `main-notes` live under `<instance data>/lead/<repoId>/`;
it launches at the repository root in `loom-lead-<repoId>` on the same private server. Main's
separate authenticated MCP identity scopes issue reads and human-command tools to that repository.
`set_note` atomically replaces its own notes (at most 2,000 characters), included on each launch.
The Claude launch restricts Main to Loom MCP and read-only file tools within the repository;
the agent has no terminal attach capability. Human viewers still attach to its panel.
The coordinator persists the per-instance last-opened repository in SQLite and publishes selection
to windows. Selecting another repository retargets a viewer without stopping either session.
Startup recovers every per-repository recipe and idempotently migrates the legacy single recipe
to the first registered repository, keeping its session ID and token.
This conversation-only policy is separate from issue planners' and reviewers' edit restrictions,
so those issue roles retain the tools needed to inspect the repository and run tests.
Main may also send short questions or heads-ups through `message_agent`, fire-and-forget. Every
message is recorded, task-run delivery uses the core send gate and native receipt path, and
Main message notes and idempotency receipts use dedicated SQLite tables. Destinations are exact
task/run or task/role identities; Main never waits for an answer or assigns work through messages. The human-command tools enqueue the same guarded inputs as the CLI; they do not
change stage ownership. Issue-run tools and Main tools reject each other's identities. See
[Main](design/ui.md#main) for its lifecycle, recovery and bottom-bar UI.

### Claude Code

Verified in [spike 02](../spikes/02-claude-hooks/FINDINGS.md) (Claude Code 2.1.268):

- **Status comes from `claude agents --json`; hooks are hints.** Poll it on every hook, and every
  1–2 s while a Loom-launched session is busy or waiting. Hooks carry the detail: session and prompt
  IDs, the tool, whether a dialog is a question or a permission, answers, and the last assistant
  message. No hook fires on Esc, on a crash, or when a permission is approved.
- **Install hooks per session with `--settings`, never at user level.** Use HTTP hooks with
  `timeout: 1`, plus a `command` hook for SessionStart, which HTTP hooks skip. With a dead endpoint,
  every session shows an error after every turn; a hung one adds its timeout to every hook. Sessions
  started by hand are still found through `claude agents --json`.
- **A settings file carries hooks, not MCP servers.** `mcpServers` in a `--settings` file is
  ignored by 2.1.269, so Loom's MCP server goes in a `--mcp-config` file written beside the
  settings (and passed to the Agent SDK natively for headless runs). Verified in the Claude
  adapter, phase 2.
- **Status rules.** AskUserQuestion (via PreToolUse or PermissionRequest) means needs input; any other
  PermissionRequest means needs permission. Ignore subagent events with an empty `agent_type`. Don't
  wait for the permission Notification; it arrives about 6 s late.
- **Turns are identified by `prompt_id`.** A prompt sent while Claude is working joins the running
  turn, so several prompts can share one turn and one Stop.
- **Sending text through the pane host** delivered 89 of 89 plain prompts exactly once on both hosts.
  Text starting with `/` runs a slash command, and text starting with `!` runs a shell command with no
  permission prompt, so the adapter refuses both. Tabs and CR are normalized. A paste is only ever
  "bytes written": in spike 06 a paste into a pending permission dialog **approved the command** and
  submitted no prompt, so the coordinator gates every send on the provider's status. A message counts
  as delivered only when its UserPromptSubmit arrives.
- **Crashes** give no SessionEnd; detect one as the `claude agents` entry disappearing. Resume with
  `claude --resume <id> --settings <loom settings>`. The killed turn's in-flight tool call is missing
  from the transcript.
- **Background sessions (`claude --bg`)** ignore `--session-id` and can't be prompted while running,
  so Loom doesn't launch runs that way. Background sessions it finds are observe-only.
- **Trust dialog.** A new worktree shows Claude's folder-trust dialog, whose default choice exits the
  session, so a blind Enter kills it. Only the human answers it. Herdr used to report it from the
  screen; the pane host does not, and no provider-native signal for it has been measured, so such a
  run stays `starting` until SessionStart and the existing stall attention surfaces it. Measuring what
  `claude agents --json` reports while the dialog is up is an open question.

### The pane host

tmux owns terminal processes, on a private server `-L loom-<instance>`, chosen in
[spike 06](../spikes/06-tmux-pane-host/FINDINGS.md) (tmux 3.7c) and built in
`packages/adapters/tmux`. Terminal behaviour was verified in
[spike 03](../spikes/03-embedded-terminal/FINDINGS.md) and re-measured in spike 06:

- The in-app view is node-pty in the Electron main process running the host's `attachArgs`,
  rendered with xterm.js. Keystroke to glyph was 5–6 ms p95.
- **Any number of clients may attach.** Two Loom windows and a native Ghostty window showed the
  same agent at once, with no eviction and no takeover flow. Detaching one never stops the agent.
- **One session per issue, one window per run, and no idle windows**: the session exists only
  while a run or scratch pane does. There is also a *grouped* session per attach target: clients
  on the same session share its current window, so each view gets its own grouped session and picks
  its window independently. Workbench also uses tmux's `active-pane` client flag and initializes
  client-local selection before targeting sibling panes; the adapter integration test verifies
  input isolation on tmux 3.7c.
- Session/window names are mutable tmux metadata. Rename targets use a host generation plus
  native session/window ID; stored pane references continue to resolve by generation, window ID
  and pane ID. The native session retains its original workspace key in `@loom_workspace_id`, so
  task linkage and subsequent launches survive a rename and coordinator restart. No name is
  persisted in the renderer, and inventory patches do not remount terminal viewers.
- **The shared pane has one size**, and the latest active client's size wins (`window-size latest`,
  `aggressive-resize on`); a differently sized view is cropped or padded. Give the embedded
  terminal a minimum width (about 100 columns), and resize only when the panel resizes, debounced.
- **Scrollback lives in tmux.** The mouse wheel enters copy mode and reaches tmux history; search
  and history still read provider transcripts, not the terminal buffer.
- Workbench shows exactly one native space at a time, with windows in native index order and
  panes laid out from tmux's `window_layout`. These are disposable native facts in the inventory.
  Workbench clients use the native window size and crop their screen to the target pane rectangle;
  Dockview resizing scales the view without changing the native window layout.
  Closing in the Workbench is killing (decision 2026-09-13): Close pane, tab and space send
  `close_terminal` with a `pane`, `window` or `session` scope, and the coordinator kills that
  much on the pane host, refusing while a live Loom run sits inside the scope. The viewer goes
  once the host confirms. Mode and window teardown still only detach clients.
- Workbench New tab and Split use the idempotent scratch-shell path: a generation-scoped target
  resolves the selected space, and Split creates a pane in that target's window. Stale or dead
  targets fail; they never create a replacement space. With no selection, New terminal creates
  a window in the standalone Workbench space. No shell is created during render or navigation.
- Issue detail's Terminal tab resolves through `open_task_terminal`: a live recorded agent pane
  takes precedence; otherwise an issue-keyed human shell opens in the surviving worktree or the
  configured project root. Reopening reuses that shell. The coordinator reads and displays the
  actual Git branch, including detached HEAD, and never checks out a branch when opening a terminal.
  Native lookup failures are errors rather than permission to launch a competing shell.
- **Shift+Enter needs `extended-keys always`, `extended-keys-format csi-u` and
  `terminal-features ",xterm*:extkeys"`**, loaded before the pane exists — and still needs the
  renderer's CSI-u shim. Changing the options afterwards does not reach an existing pane.
- **The pane environment is an allowlist, built by Loom.** `-e NAME=` overrides a value but does not
  remove the name; only `set-environment -r` removes, `update-environment` must be empty so
  attaching adds nothing, and `PATH` comes from the tmux *client* process rather than `-e`. An
  inherited `CLAUDE_CODE_CHILD_SESSION` turned off transcript saving in Claude agents, which breaks
  resuming (principle 7).
- **Pane exits come from `pane_dead` plus `pane_dead_status`** (`remain-on-exit on`), with a global
  `pane-died` hook feeding one control-mode subscription. `%exit` means the control client is
  leaving, never that a pane exited. Measured: dead 136 ms after the keystroke, hint 773 ms later.
- "Open in Ghostty" uses AppleScript (`new window with configuration`, running the host's
  `attachArgs`) and keeps the returned window ID, so Loom can focus that window later.

## Stage rules: code versus agents

**Code decides:**
- triggers, transitions and their guards;
- concurrency, retries and timeouts;
- the cap on review rounds;
- provider availability;
- the worktree lifecycle;
- which commit an approval applies to, and the merge itself.

**Agents decide within a stage:**
- how to investigate, and what the plan says;
- which areas the work will likely touch, and the risk;
- which tests prove the work;
- the implementation;
- findings and their severity, and whether a finding is fixed.

## Parallel work

- One issue = one branch = one worktree = one pane-host session, with one window per run.
- A `WORKFLOW.md` owned by each repo lists its setup, env bootstrap, test, lint, dev-server and teardown
  commands, plus its prompt templates.
- **Ports:** each issue gets a slot (`PORT = base + slot*10`), written into the worktree's env. Dev servers run
  in panes of the issue's session.
- **Services and databases:** each issue gets its own compose project or database name. If a repo can't
  support that, it's marked serial-tests and a lock guards its test step.
- **Dependencies:** "blocked by" links. An issue starts only after its blockers are merged. No stacked PRs in v1.
- **Overlapping changes:**
  - The planner lists the areas it expects to touch, and the coordinator warns about overlap with active issues.
  - After each merge, `git merge-tree --write-tree` flags branches that now conflict.
  - The agent rebases and re-runs tests before Awaiting approval.
  - Merges happen in approval order.
- **Caps:** a global cap (start at 4 agents) and a per-provider cap.

## Context handoffs

Issue agent routing can be overridden per role with the instance's `LOOM_PROVIDER_PLANNER`,
`LOOM_PROVIDER_IMPLEMENTER`, and `LOOM_PROVIDER_REVIEWER` settings. Overrides apply to new
runs, including later roles on existing issues; they never migrate an existing provider session.
Models remain configurable per provider, with explicit `LOOM_CODEX_REASONING_EFFORT` for Codex.
The coordinator captures model and reasoning in durable run/action/recipe records before launch;
retries preserve them, and Codex turns and the private TUI config receive the captured settings.

A human can explicitly replace the current planning, implementation or review run with
`restart_run`, naming the current run ID. The coordinator snapshots the current provider/model/
reasoning settings, supersedes the old run, and durably requests its retirement. Only after
retirement succeeds does it launch a new run/session with a distinct ID in the same worktree.
Retries retain the selected run's settings; replacement retains the issue's stage, artifacts,
findings and review round. Old run records and provider transcripts remain available. A repeated
command for the superseded ID cannot launch another replacement. Unknown retirement state blocks
launch rather than allowing two agents to edit the same worktree.

Human `retry` also accepts an unfinished run whose observation is unknown, or which is still
starting, working, idle or blocked by provider input. It retires that attempt before rotating
the session epoch and launching again on the same run row with a higher attempt count. Pending
messages are copied to new delivery identities for the fresh session; old transport receipts
cannot confirm them. Retry replies wait for the reconciler's acceptance or explicit rejection.

Agents hand off through artifacts, not transcripts. Each issue's artifacts live in the coordinator's data directory.
Agents reach them through `get_task_context`, and as files in `<worktree>/.task/`, which is kept out of git via `.git/info/exclude`.

- `brief.md`
- `plan.md`: goal, non-goals, steps, areas, acceptance criteria, test plan, risks, open questions
- `decisions.md`, append-only
- `findings.json`: id, round, source, severity, location, status, resolution
- test results
- a handoff note at every role change

Knowledge about the repo itself lives in `AGENTS.md`; `CLAUDE.md` imports it. Fix rounds resume the
implementer's session. Reviewers start fresh each round and are given the previous findings. Context
that crosses providers goes only through artifacts.

## Review and approval

- The reviewer has the same task-worktree write/commit access and launch paths as the implementer
  in both interactive and headless modes. Only planners retain Codex's read-only sandbox and
  Claude's disallowed edit tools. Reviewers run tests and read the diff against the accepted plan
  and AGENTS.md. Most reviews should change nothing: no restyling, refactoring or scope expansion.
  Fix only actual bugs, failing or missing tests required by the plan, or AGENTS.md violations;
  commit each fix separately with a message naming the finding.
- `submit_review` accepts the clean task-branch HEAD at the round head or a descendant. Git supplies
  the complete oldest-first `roundHead..reviewedSha` range; the authenticated reviewer must record
  exactly that range as `reviewerCommits`. This is attribution to the submitting run, not a claim
  inferred from Git author names. A `fixed` finding/verdict names a fixing `commitSha` in that range
  and never counts as open blocking. An `escalate` finding/verdict must carry a reason: a design
  change, unanticipated work or work across many files that cannot safely be fixed inline. Only
  explicit escalation sends transition 11 to the implementer; all other reviewer reports are
  non-blocking. Human request-changes and CI recovery keep their existing paths.
- The coordinator stores the complete review submission in the versioned handoff artifact and
  its reviewer commit list/pending publication in review state. On convergence it emits
  `push_branch(reviewedSha)` before `open_pr`, retaining the implementer's submit-for-review push.
  It stays `in_review` while publication is pending, then enters `awaiting_approval` only after a
  fresh PR observation confirms the reviewed head, positive mergeability and non-failing CI for
  that head. This survives restart and duplicate hints; an old PR head during publication never
  starts a spurious review round. Agents never push to the base branch or merge.
- The diff view uses `@pierre/diffs` with `CodeView` and a bounded worker pool. Findings, human comments
  and CI annotations render in its annotation slots. It can show the whole branch or only the changes
  since the last review round. From [spike 04](../spikes/04-pierre-diffs/FINDINGS.md):
  - Feed it Git patches, or compute content diffs off the renderer thread. The workers only offload
    syntax highlighting.
  - Give each file a stable ID, and bump its version whenever its content or annotations change.
    Pierre ignores a changed file whose version didn't change.
  - Take file status, binary and rename facts, and paths from Git metadata, not from the patch text.
    Treat empty or unparseable input as an error, never as a clean diff.
  - Loom builds the review shell: file list, viewed state, keyboard navigation, outdated findings.
- **Finding anchors.** Pierre keeps a finding on its old line number even after a new commit moves the
  code. The coordinator stores an immutable original anchor (base and head SHA, path, blob ID, side,
  line range, hashes of the selected and surrounding text) plus a current location with a mapping
  status: exact, moved, ambiguous or outdated. On a new head it maps ranges through Git hunks and
  renames. It never silently picks the nearest duplicate, and never resolves a finding because its
  line disappeared.
- The coordinator records an approval against three things: the head commit, a snapshot of the findings, and the CI state.
  Any new commit voids it. "Request changes" turns the human's comments into blocking findings.
- Repository PR commands also go through the executor, independently of issue stages. They re-read
  the head the human named and refuse open draft PRs, unknown/conflicting mergeability and pending
  or failed CI; zero checks is allowed. They always request squash and the matching head, with no
  auto-merge or override. Adapter precondition errors have the same classification as issue `merge_pr`.
  A merge initiated from a PR view reaches issue Done only through the existing GitHub observation
  path. Close and remote branch deletion re-read the owner and are idempotent; no local checkout is
  changed. No durable issue or approval is invented for an off-pipeline PR.
- Merging runs `gh pr merge --squash --match-head-commit <approvedSHA>`, or adds `--auto` while CI is still
  running. GitHub won't let you approve your own PR. If you want approvals to count on GitHub itself,
  have agents push as a bot or GitHub App identity.

## Reliability

| Failure | Handling |
|---|---|
| UI closed or crashed | Nothing happens. On reopen, the UI reconnects and gets a fresh snapshot. |
| Coordinator restart | 1. Load SQLite.<br>2. Scan worktrees, panes, loaded Codex threads, `claude agents --json` and PRs.<br>3. Resubscribe to events.<br>4. Resume runs that vanished using their stored session ID (N attempts). |
| Pane host stop, crash or kill | Every pane process dies, shells included (spikes 05 and 06). The host has no restore feature and needs none: Loom recreates the server, its sessions and each run's pane from stored state — session or thread ID, cwd, full command line and environment. Pane IDs restart at `%0`, so stale refs name nothing and every ref carries its host generation. Measured at about 30 s to a fresh reply from both providers. A Codex turn in flight completes because its app-server runs outside the pane host; Claude's is lost and re-sent. |
| Codex app-server restart | Desired thread subscriptions survive the connection generation and are resumed/hydrated before retrying reads. An unavailable owner leaves runs `unknown`; after `unknownGraceMs` they raise `observability_failure`. Interrupted or completed turns without a Loom submission remain live and can raise `idle_without_submission`; they are not inferred ended. |
| Agent failure | Detected via StopFailure, a failed Codex turn, a `claude agents` entry vanishing without SessionEnd, or the pane exiting. Retry with `min(10s·2^(n−1), cap)` backoff; after 3 attempts, flag the issue failed and notify the human (see `docs/design/core.md` §3). |
| Stall | No events for N minutes → set the attention flag. Don't kill it; the human may be typing. |
| Rate limits | Codex `account/rateLimits/updated` or Claude StopFailure → the provider is cooling down until its reset. Queue new work, and offer to switch providers only for runs that haven't started. |
| Duplicate or out-of-order events | Idempotent handlers, compare-and-set transitions, one reconcile at a time per issue. |
| Review loops | At most 3 rounds. Escalate when a finding is reopened or the number of findings stops dropping. Each issue has a time and cost budget. |

Out of scope: message brokers, event-sourcing frameworks, sync engines, and multi-machine support in v1
(one machine runs everything, but the coordinator binds to a configurable address with token
authentication so a phone inbox and an always-on host can follow without a rewrite),
plugins, a custom terminal emulator, a custom diff renderer. One exception: a small key encoder in the
terminal renderer that sends Shift+Enter and other modified keys in the kitty keyboard format, until
xterm.js supports that protocol itself.

Codex 0.154.0 observations from spike 01: a running turn survived the last subscriber disconnecting;
`thread/resume` restored its current state and subsequent events. A server crash recovered saved
history with the unfinished turn marked interrupted, but a pending command visible in live events
was absent from disk history. `turn/interrupt` also left a running shell command alive. Before retrying
side effects, reconcile the actual worktree and tool state; neither interruption nor crash recovery
guarantees that a command did not run. The broader restart matrix remains spike 05.

## Stack

| Area | Choice |
|---|---|
| App shell and UI | Electron, React |
| Lists | TanStack Virtual |
| Board drag and drop | dnd-kit or Atlassian's pragmatic-drag-and-drop |
| Command palette | cmdk |
| Keyboard shortcuts | tinykeys |
| UI primitives | Radix |
| Terminal | xterm.js 6 with the WebGL, fit and unicode-graphemes addons, plus node-pty. ghostty-web 0.4.0 failed spike 03 (no mouse, broken keys, high idle CPU). |
| Diffs | `@pierre/diffs` |
| Storage | better-sqlite3 |
| Codex | TypeScript bindings from `codex app-server generate-ts` |
| Claude | `@anthropic-ai/claude-agent-sdk` |
| GitHub | `gh` / Octokit |

## Verified versus to be confirmed

**Verified.** Checked against docs and the CLI help of codex-cli 0.154, Claude Code 2.1.268, tmux 3.7c and gh 2.90 (Sept 2026):
- **Codex:** the app-server thread, turn and approval methods and the rate-limit events; the shared daemon; TUI `--remote`.
- **Claude Code:** `--session-id`; HTTP hooks and the event list above; background sessions and `claude agents --json`; Agent SDK resume and fork.
- **tmux:** `new-session`/`new-window` with `-e` and an argv command; `list-panes -a -F`; `set-environment -r`; `set-buffer`/`paste-buffer -p`; `send-keys`; grouped sessions; control mode with `refresh-client -B`.
- **GitHub CLI:** `gh pr merge --match-head-commit`.
- **Pierre Diffs:** `@pierre/diffs` 1.4.2 (Apache-2.0), with annotations and a worker pool.
- **ghostty-web:** 0.4.0 (MIT), with the xterm.js API.

**To be confirmed** (see `spikes/`):
- **01 completed:** concurrent Codex attach and approval fan-out on 0.154.0. See the findings for
  bounded recovery results and remaining race/timeout questions; transport remains experimental.
- **02 completed:** `claude agents --json` for status, per-session hooks for detail; pasting a prompt
  delivers reliably, but text starting with `/` or `!` must be refused. See the findings.
- **03 completed:** an embedded attach client with xterm.js works; "Open in Ghostty" via AppleScript.
  See the findings.
- **06 completed:** tmux meets the pane-host budgets and allows concurrent clients, so it replaces
  Herdr; provider-gated sends and per-generation pane refs are required. See the findings.
- **04 completed:** Pierre with `CodeView` and workers handles large diffs; anchoring findings across
  commits is Loom's job. See the findings.
- **05 completed:** nothing in a pane survives a host restart; Loom relaunches from stored state, and
  the Codex app-server lives outside the pane host. See the findings.

### Coordinator automation

The Operator was removed by user decision on 2026-09-13. Two narrow behaviours remain in
plain core code, using fresh provider/git observations and the existing guarded outbox:

- A Loom-launched implementer's native permission request is accepted for an exact command
  from its registered repository's validated `WORKFLOW.md`, or a conservative simple `git add`,
  `git commit -m` or `pnpm install` command. Extra install flags require an exact workflow entry.
  Claude requires a waiting native Bash PermissionRequest with an occurrence ID; Codex requires
  a command approval on the current connection generation. Questions, trust dialogs and all
  other commands retain `provider_input` attention for the human. Actions are deduplicated by
  request identity and revalidated immediately before execution.
- A vanished Loom-launched interactive implementation with no accepted submission, review,
  replacement or live run can have its clean committed branch pushed through `push_branch`.
  The exact recorded HEAD must be ahead of base and its remote (or the remote branch absent);
  git proves remote ancestry and the executor rechecks worktree, branch and HEAD. Push is never
  forced. The coordinator retains `run_vanished` attention, never opens a PR automatically and
  never fabricates a submission or changes the stage. Reconciliation and recovery reuse the
  same commit-keyed outbox intent.

Existing headless retry limits and human plan/merge approvals remain unchanged. Runtime failures
are logged for the human; no agent files bugs or resets retry budgets automatically.

### Repository review preferences and Overview actions

Loom owns pinned PR stars and explicit issue links in SQLite metadata, keyed by repository and
PR number; GitHub remains the owner of PR content. PR projections prefer a valid same-repository
manual issue link over branch matching. These preferences do not rewrite branches, workflow
state or approvals. Pin/link commands re-read local ownership before publishing; comment commands
run through the executor and GitHub adapter, then refresh GitHub through the existing PR path.
A hidden per-submission marker in the posted comment lets the adapter recover an uncertain write
or repeated command by reading all comment pages. Comment text travels through stdin, never shell
interpolation. The renderer retains only the active draft and submission identity.
Requested reviewers come from GraphQL. Branch divergence is read from an immutable REST comparison
and cached by both SHAs; it publishes after detail so it cannot delay Overview or diff rendering.
No branch status is inferred from mergeability alone, except GitHub's explicit conflict state.

### PR Diff review state and immutable content

`save_review_state` also accepts a repository/PR target, independent of an issue. SQLite metadata
owns its viewed-file records at one head SHA; per-file updates preserve other windows' marks and
publish through the existing PR detail projection. The coordinator checks the current GitHub head
and file membership before saving. A different head projects an empty viewed set. Renderer state
contains only transient selection/settings and disposable content read results.

Commit and full-file requests travel through validated coordinator commands and the GitHub adapter.
Commit membership is checked against the observed PR head; the REST commit's first parent supplies
its immutable comparison range. Full file reads resolve rename paths and the merge base from GitHub
comparison metadata, never patch guesses. Missing comparison metadata, binary data, oversized files
and parse failures are explicit errors. Contents are bounded at 2 MiB per side; whitespace-filtered
patches are computed in the adapter with a one-second computation limit. No local checkout or
provider session is involved. The UI continues to use Pierre CodeView and its bounded worker pool.

Reviews polish projects the reverse of each saved PR-to-issue link into task inbox metadata;
there is still one durable relation, and no workflow PR or branch is rewritten. Link commands
publish both sides before acknowledging, including removal from the previous issue on relink.
Newly observed merges in either PR lists or detail are hints to invalidate the matching task
branch's observation cache and enqueue reconciliation immediately, regardless of a manual issue
reference. GitHub's task observation alone supplies the merged fact that makes the task Done.
Cache invalidation generations prevent pre-hint reads from restoring a stale conditional body.
