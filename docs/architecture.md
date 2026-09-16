# Loom architecture

Loom runs on one machine: an Electron desktop connects to a Node/TypeScript coordinator over an
authenticated WebSocket. The coordinator persists its state in SQLite and drives external tools
through adapters. Closing a window does not stop the coordinator or its agents.

[AGENTS.md](../AGENTS.md) owns the seven architectural principles and repository safety rules.
This document explains their implementation. [Core workflow](design/core.md) owns stage and
reconciliation rules; [agents](design/agents.md) owns role behavior; [UI](design/ui.md) owns interaction.

## Ownership

| Fact | Owner | Loom representation |
|---|---|---|
| Issues, stages, plans, findings, approvals, run records and test evidence | Coordinator | SQLite records and versioned artifacts |
| Branches and worktrees | Git | References and fresh observations |
| PRs, CI, reviews and merge state | GitHub | Disposable projections with read times |
| Provider sessions, transcripts, live status and token usage | Codex / Claude Code | Session references and bounded caches |
| Terminal processes, native layouts and display titles | Private tmux server | Generation-scoped pane references and inventory |
| Settings, repository selection, PR pins/issue links and viewed-file marks | Coordinator | Versioned settings and metadata |
| Selection, open viewers, drafts and transient layout | Each window | Disposable memory |

The canonical worktree path joins an issue to its provider sessions, panes and branch. Normalize
real paths before matching (including macOS `/var` versus `/private/var`). Discovered sessions in
an issue's worktree are external runs; they are observed without taking control.

## Source map

| Component | Responsibility |
|---|---|
| [core](../packages/core/README.md) | Pure decisions and types; no I/O |
| [store](../packages/store/README.md) | Transactions, receipts, artifacts and migrations |
| [coordinator](../apps/coordinator/README.md) | Owner reads, action execution, launch/recovery and servers |
| [MCP](../packages/mcp/README.md) | Validated agent tools and identity |
| [protocol](../packages/protocol/README.md) | Window/CLI schemas, snapshots, patches and commands |
| [desktop](../apps/desktop/README.md) | Electron, React, xterm.js and Pierre diff views |
| [fake-agent](../packages/fake-agent/README.md) | Deterministic provider scenarios for automated tests |

## Agent integration

| Channel | Codex | Claude Code |
|---|---|---|
| Control | App-server thread/turn methods; steer names the expected turn | Agent SDK headless; provider-gated paste and Escape for interactive sessions |
| Observe | App-server snapshots and notifications | `claude agents --json`, per-session hooks and transcripts |
| Human attach | TUI `resume --remote` on the issue's app-server | Interactive pane, or explicit headless handoff |
| Agent results | Loom MCP | Loom MCP |

Each issue has one private Codex app-server outside tmux, shared by its runs. Thread-specific MCP
registration carries the run's identity. A plain Codex session on another runtime is not a live
thread on that server: disk history cannot prove its current execution state. Do not take control
without an explicit handoff. See the [Codex adapter](../packages/adapters/codex/README.md).

Claude hooks are installed with per-session settings; MCP registration is a separate file. Hooks
supply prompt/request detail and durable receipts, while native session reads supply live status.
Interactive text is normalized and refuses leading `/` or `!`, which Claude treats as commands.
Trust dialogs require the human. See the [Claude adapter](../packages/adapters/claude/README.md).

Session identity is recorded before work starts: Claude's UUID is derived before launch; Codex's
`thread/start` result commits before the first `turn/start`. Private launch recipes persist cwd,
executable, arguments, model, access, environment and MCP credentials outside the repository.
Retries retain the captured recipe; explicit run replacement uses current effective settings.

Provider status, issue stage and attention are separate facts. A failed owner read means unknown,
not ended. Native approval/request identities are scoped to their session and connection generation;
a resolved or stale request cannot be answered by replaying an old UI action.

### Conversation and usage

Conversation views are bounded, subscription-scoped projections: Claude transcript JSONL or Codex
`thread/read` on an already-running server. Reading a conversation never launches or forks an agent.
Text, thinking and tool rows refresh from native hints and polling. Sends and answers use existing
coordinator delivery paths; terminal output never supplies a delivery receipt.

Token usage is cumulative per provider session. Reconciliation replaces the cached total rather
than adding repeated observations; session rotation retains earlier totals. A failed read preserves
the last known value. Claude usage includes provider subagent transcripts when available.

### Main

Main's scope, permissions, notes and messages are documented in [agent layers](design/agents.md#main).
Its UI is documented under [Main and chat](design/ui.md#main).

## Pane host and embedded terminals

The [tmux adapter](../packages/adapters/tmux/README.md) owns native terminal operations. All targets
include the server generation because pane IDs restart after server death. Each issue uses a native
session with windows for runs and scratch shells; Workbench also supports standalone terminals.

Each viewer attaches through its own grouped session and client-local pane selection. Multiple
windows can view the same process without sharing input focus. Electron main owns the viewer PTY;
xterm.js renders it. Closing a viewer detaches its client; explicit native close commands are
separate and reject scopes containing live Loom runs.

Native tmux layout supplies pane rectangles. Workbench crops/scales each client's full-window screen
to its pane. Display titles are native `@loom_space_title`, `@loom_tab_title` and `@loom_pane_title`
options, not renames of session/window identity. Inventory excludes attach aliases and monitor
sessions; failed reads retain last-good rows with unavailable health.

The pane environment is an allowlist; attaching must not import the user's environment. Extended-key
options are installed before panes start; the renderer also encodes modified keys. Host history can
be replayed into viewer scrollback, but transcripts remain the source for conversation and search.

## Recovery

Recovery reads owners before replaying uncertain work. The store distinguishes pending executor
receipts from actions whose result is unknown; see [store recovery](../packages/store/README.md#executor-boundary).

| Failure | Response |
|---|---|
| Window closes/disconnects | Detach viewers; reconnect with a fresh snapshot |
| Coordinator restarts | Reload state and recipes, recover uncertain actions, resume recorded sessions, reconcile |
| Pane host dies | Pane processes die; old generation references are invalid; recovery can recreate owned panes from recipes |
| Codex connection changes | Resume and hydrate subscribed threads; discard old-generation request identities |
| Provider cannot be read | Keep status unknown; raise attention after the configured grace |
| Headless run fails | Bounded retry with retained session when resumable |
| Interactive run vanishes during normal operation | End it and raise attention; human retry controls relaunch |
| Run stalls or idles without required submission | Raise attention; do not infer completion or kill it |

At coordinator startup, persisted native in-flight turn IDs produce deterministic restart inputs.
After a fresh read, core records whether each turn completed, needs one normal-path continuation,
or is no longer needed. It does not replay every interrupted turn. Shutdown does not run a final
reconcile that could launch new work while adapters close.

Pane recovery during coordinator startup is distinct from automatically retrying an interactive
run that vanishes during normal operation. A Codex turn may continue through tmux death because
its app-server is outside tmux; a killed Claude process loses its in-flight turn. Neither a crash
nor an interrupt proves that an external command did not execute.

Private app-server stale-process cleanup refuses to signal a server with a recorded live Codex run.
When cleanup is allowed, process identity and the exact private socket are checked again before a
signal. Persistent failures remain visible to the human.

## Settings

[core/settings.ts](../packages/core/src/settings.ts) owns the catalog and defaults;
[coordinator/config.ts](../apps/coordinator/src/config.ts) maps environment overrides. Do not copy
the catalog into another document. [Coordinator setup](../apps/coordinator/README.md#configuration)
lists bootstrap variables.

Precedence is explicit task-creation values, environment, repository overrides, global defaults,
then built-ins. Task workflow policy is captured at creation; role profiles are captured per run.
Settings label their effect as immediate, next task, next run or restart. Mutations check the expected
version and append a redacted audit row. Secret-bearing keys are rejected.

Repository overrides cover roles, workflow defaults, base branch and serialized tests. Capacity,
timing, executable paths, Main, GitHub observation and desktop preferences are instance-wide.
Identity, storage location, authentication and listener endpoints are bootstrap configuration, not
editable preferences. Reset resolves from the startup/environment baseline.

Desktop preferences live in coordinator settings; a private desktop startup cache is derived,
not another owner. Store migration 0011 requires repository settings to have been imported by
a #203 build before upgrading. It refuses old repository settings rather than dropping them.
The migration runner backs up committed WAL data before filling missing row fields atomically.
Pending messages begin their missing timeout interval at migration time. Reopening is a no-op.

## GitHub projections

[GitHub adapter](../packages/adapters/github/README.md) and
[coordinator/pull-requests.ts](../apps/coordinator/src/pull-requests.ts) implement repository PR
lists and subscribed details independently of issue stages. Matching windows share polls: lists
refresh every 60 seconds and open details every 30 seconds; unused subscriptions release polling.
Viewer identity and review requests come from GitHub, not local Git author configuration.

Overview metadata publishes before the diff. Immutable base/head comparisons supply patches;
changed heads invalidate content and mismatched patches are discarded. Read failures retain the
last good projection with an error. Full-file and commit reads verify PR membership and immutable
ranges; binary, oversized or incomplete content is explicit. Limits live in the adapters.

Pins and explicit issue links are repository/PR metadata. Manual links take precedence over branch
matching for display but do not rewrite workflow branch/PR identity. Reverse links are projections
of the same relation. Observed merges invalidate matching task-branch reads and enqueue reconciliation;
only the task's GitHub observation can make it Done.

Viewed-file marks belong to a PR head; a new head displays an empty set. Comment submission uses a
persisted command identity and recoverable GitHub marker. Repository PR commands re-read owner state;
issue-owned PRs use the issue approval path described in [core workflow](design/core.md#review-and-merge).

### Issue description and implementation publication

The human's description remains the request. Each accepted implementer submission replaces the
versioned `implementation` artifact: summary, recorded decisions and submitted tests at one head
SHA. Reviewer handoffs leave it unchanged. The issue Overview and PR body use this same content;
PR bodies include a plain-text issue reference such as `Issue: LOOM-216`.

Initial PR publication waits for successful review. Later submissions enqueue `update_pr_body`
once GitHub reports the submitted head, keyed by PR, artifact version and body hash. The executor
checks issue ownership and submission version; the GitHub adapter checks the open PR's branch and
head, skips identical bodies and writes literal JSON through stdin. Restart requeues uncertain
updates through the same idempotent owner checks.

## Daily AI builder brief

[coordinator/briefs.ts](../apps/coordinator/src/briefs.ts) owns one instance-wide schedule at 07:00
Asia/Makassar, checked at startup and every 30 seconds. It catches up only today's missed edition.
The scheduled date is persisted before launch; at most one automatic attempt runs per local date.
A manual run after 07:00 satisfies that date too. Run now remains available while scheduling is
paused; concurrent requests coalesce into an active run and repeated run IDs return their record.

The brief uses a dedicated instance-data workspace and a saved provider session UUID. The Claude
Agent SDK runs Sonnet with web tools, a $3 budget and 30-turn limit, without repository tools,
inherited settings or MCP servers. Structured output is validated and requires a successful live
web lookup. Source relevance and evidence strength remain research judgments.

SQLite owns schedule, run records and final briefs; the provider owns transcripts. History returns
the latest 30 runs; older runs remain addressable. Shutdown aborts the owned query; startup marks
unfinished records interrupted. Failures require Run now or the next scheduled date, with no
uncertain automatic replay. Closing a window does not stop the brief; the coordinator must be running
on an awake host. Briefs create no issue, branch, pane or Main message.

## Data shape ownership

Core owns entity TypeScript types and closed value lists as `as const` arrays; union types derive
from those arrays. Core remains free of runtime dependencies. Protocol owns entity zod shapes,
including artifact metadata and task context. Its schema factory defines each field once and
selects explicit wire or storage validation rules. Store and MCP compose protocol schemas.

Wire schemas keep strict objects and wire-specific invariants. Storage schemas preserve legacy
scalar rules, defaults and unknown-key stripping, including omission of derived message delivery
reasons. MCP keeps agent-only input rules locally. Sharing a shape never silently changes which
existing rows or wire frames can be read. Type-equality and boundary compatibility tests enforce
these contracts.

## On-demand research

The coordinator's `Research` owner holds interactive sessions independently of task stages.
`launchAgent` is the common provider launch path for tasks and research: it persists the private
recipe and MCP identity before launching, records Codex's thread ID before its first turn, and
opens an owned pane workspace. Research uses the human's existing absolute directory as cwd.
A second concurrent start is refused. Follow-up mentions queue durably; there is no schedule.

Research tools are isolated from task-run and Main tools in both directions. The research token
can submit a complete document and read/list files within its recorded directory. Scoped reads
resolve real paths and reject traversal and symlinks outside that directory. General shell and
native filesystem tools are disabled: Codex's native read-only sandbox prevents writes but does
not itself restrict reads to cwd. Codex turns additionally set `networkAccess: false`; both
providers retain their web tools. Pages and local contents are untrusted evidence, never
instructions. No structured provider output or successful-web-lookup gate is involved.

Only validated `submit_research` replaces a document in SQLite. Migration 0014 stores ordered
research comments separately from documents, with author (human, Main or agent), text, time and
delivery state. `comment_research` requires a caller-generated `requestId`, stored as the comment
ID. Identical retries return the existing comment; reuse for another entry, author or text is
refused. The desktop retains this ID until success, and Main supplies it through MCP.
The command stores a note; a case-insensitive `@loom` mention queues a
follow-up with the existing document as context. Main's authenticated MCP path fixes its author.
Main-saved entries accept notes but refuse mentions because they have no research session.
Provider observation drains pending mentions when the entry is no longer running, its session is
idle and no other research is active. Delivery is claimed before sending, so an uncertain send is
never replayed after restart. A completed entry reopens on dispatch and completes on submission.
Code appends agent start, submission and failure comments; failed turns preserve the last submitted
version. The desktop shares the PR comment composer and keyboard-readable activity list. `resume_research` restores the owned pane from its recipe without sending a prompt.
Provider hints and the same native provider reads used by other sessions drive observed status;
terminal output is never parsed. Restart loads recipes and reconnects observations without
replaying messages. Running entries remain visible, and completed documents stay intact.
If launch stopped before a recipe or provider session ID was recorded, recovery marks the
request failed without replaying it, freeing the active slot for a new request.

Quick/standard/deep capture token ceilings of 30k/100k/200k per request, enforced against observed
provider usage; exhaustion interrupts the owned turn. The prompt also guides the agent toward
10/30/60 research steps, rather than claiming an interactive provider turn cap. The daily brief's
separate SDK runner retains its original 30-turn/$3 contract.

Migration 0013 is breaking: it retains `origin=main` documents and drops obsolete headless agent
rows, and prevents older builds from reading the new entry shape. Main's
`save_research` still stores conversation documents without a research session or live-web claim.
List, archive and unarchive operate on stored documents. Agent settings sit under Agents & models;
research panes and observed agent status appear in Workbench.
