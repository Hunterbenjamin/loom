# @loom/coordinator

The process that runs everything else. One per instance (`LOOM_INSTANCE`, `LOOM_DATA_ROOT`): it
loads state, reads the owners, runs `reconcile`, commits, executes the actions, hosts the MCP
server agents call, and serves windows over the protocol. It makes no workflow decisions of its
own — `@loom/core` does — and it owns no facts any other tool owns.

```sh
export LOOM_INSTANCE=dev LOOM_DATA_ROOT=~/.loom LOOM_TOKEN=$(openssl rand -hex 24)
loom repo add ~/src/example example/repo   # see "The CLI" for how to run `loom` today
loom serve &
loom task create example-repo "Rename the widget" "Rename Widget to Gadget everywhere."
loom task move <task> todo
loom status
loom attach <task> implementer          # prints the pane host's argv; --exec runs it
```

## The loop

One pass per task at a time; enqueues during a pass coalesce into one more pass. A pass is
`store.loadTaskState` → fresh observations → `reconcile` → `store.commit(taskId, result, version)`.
A compare-and-set conflict reloads and retries up to three times, then re-enqueues. Passes are
asked for by adapter hints, new inputs, `schedule` actions, and a full resync about every 60 s. The
store's default of one input per pass is not raised.

Observations are read outside every transaction, and a failure stays a failed `Reading`: core
treats that as unknown, never as proof. The GitHub read is conditional, keeping its ETag and the
last body here rather than in core. Provider status for a run comes from its adapter, the pane
comes from the pane host, and `resumable` is asked of the provider directly rather than inferred
from a failed read.

## The executor

Claims outbox rows, rechecks `isClaimCurrent` immediately before any side effect, maps each
`Action` kind to the adapter that owns it, and records the outcome with `store.outbox.finish` as an
`action_result` input. Actions run at least once, so every executor checks the owner first: an
existing worktree, an existing PR, a remote head already at the SHA, a session already live under
that ID. A failure is classified `retryable`, `precondition` (the world moved; re-read and decide
again) or `fatal`.

## Launching a run

The whole recipe is persisted before anything starts, in `<data>/runs/<run>/recipe.json` with mode
`0600`, outside the repository: the derived Claude session ID (UUIDv5 of `<runId>#<epoch>`), an
unguessable per-run MCP token, the per-run settings and MCP config paths, the environment
allowlist, the cwd, the executable and its arguments. The token rides in `LOOM_MCP_TOKEN` and in
the run's MCP config, never in `--settings` and never in argv. Then `ensurePane` for an interactive
run, the Agent SDK for a headless one, and one Codex app-server per task, outside the pane host.

A repeated `start_run` adopts the session the recipe already names instead of opening a second one,
and a pane that died while the coordinator was down is recreated from the recipe — never from the
pane's own argv, and never from a screen.

## The send gate

Before any send, the provider's current status is read again and must permit it: never while it is
waiting on a permission or a question, and never while it is `unknown`. A refusal is a
`precondition`, so the next pass decides afresh rather than retrying blindly. Delivery is confirmed
only by the provider; the resend rule is core's.

## The MCP host

`serveHttp` from `@loom/mcp` on loopback. `submit` persists the input and runs passes for its task
until that input is consumed, then answers with its disposition. `context` is read-only, is
role-filtered, and includes the repo's `WORKFLOW.md` commands. `resolveToken` consults current run
state on every call, so an ended or superseded run reads `stale_run` rather than `unknown_run`.
`buildAnchor` reads the reviewed blobs through the git adapter, never the working file.

### WORKFLOW.md (design note 13.3, settled here)

`<repo root>/WORKFLOW.md`. A `## <name>` heading followed by a fenced block is one command;
everything else in the file is prose. Names are lowercased with spaces folded to `_`.

- **Missing file:** no commands. Nothing fails.
- **Malformed file** (a duplicate name, a name or command the schema refuses): no commands at all,
  and one warning. Half-parsed commands are worse than none, because an agent would run them.
- **Cache:** per absolute path, invalidated on size or mtime, so editing the file takes effect
  without restarting the coordinator.

It is read only for `get_task_context`. No guard and no transition depends on it.

## Prompts

The planner, implementer and reviewer briefs are templates here, filled from the task. They are
short on purpose and point the agent at `get_task_context`, which is the only view that stays
current. They are what a run is *launched* with — Codex's developer instructions and Claude's first
headless prompt. The messages a running agent receives, including the fix round's findings
projection, are core's.

## Recovery

On startup: load the store, ask `store.outbox.startupRunning` what was uncertain and, for each row,
check the owner and either record the recovered result or `requeue` it; `thread/resume` every live
Codex run; poll `claude agents --json`; recreate an interactive run's pane from its recipe when the
host reports it dead; and reconcile every non-terminal task. Nothing is replayed on the strength of
a guess.

## Configuration

Environment variables configure the coordinator:

- `LOOM_INSTANCE` — unique name for this coordinator instance (required).
- `LOOM_DATA_ROOT` — directory where task state is stored (required).
- `LOOM_TOKEN` — bearer token for the protocol server (required, min 16 bytes).
- `LOOM_BIND` — the protocol server's loopback address, `host:port` format. Defaults to
  `127.0.0.1:47800`.
- `LOOM_MCP_PORT` — stable port for the MCP HTTP server. Defaults to `LOOM_BIND`'s port + 1
  (e.g., 47801 for the default bind port). If the port is in use, coordinator startup fails with a
  clear error message. Set this to a different value if the default port is occupied.
- `LOOM_HOOK_PORT` — stable port for the Claude hook receiver. Defaults to `LOOM_BIND`'s port + 2
  (e.g., 47802 for the default bind port). If the port is in use, coordinator startup fails with a
  clear error message. Set this to a different value if the default port is occupied.
- Other variables: `LOOM_WORKTREE_ROOT`, `LOOM_BASE_BRANCH`, `LOOM_MODEL_CODEX`, `LOOM_MODEL_CLAUDE`,
  `LOOM_TMUX`, `LOOM_CODEX`, `LOOM_CLAUDE`.

### Task agent settings

Set `LOOM_PROVIDER_PLANNER`, `LOOM_PROVIDER_IMPLEMENTER`, and `LOOM_PROVIDER_REVIEWER` to
`codex` or `claude` to override repository/task routing for new runs in this instance.
Unset roles retain their existing routing. `LOOM_MODEL_CODEX` and `LOOM_MODEL_CLAUDE` select
each provider's task model; `LOOM_CODEX_REASONING_EFFORT` explicitly selects Codex reasoning.
For example, to run all three roles on Sol with medium reasoning:

```sh
LOOM_PROVIDER_PLANNER=codex
LOOM_PROVIDER_IMPLEMENTER=codex
LOOM_PROVIDER_REVIEWER=codex
LOOM_MODEL_CODEX=gpt-5.6-sol
LOOM_CODEX_REASONING_EFFORT=medium
```

Restart the coordinator after changing its environment. These settings apply to newly created
runs, including future roles on existing tasks. Existing runs and retries keep their recorded
provider, model, and reasoning level. To explicitly replace a current planning, implementation,
or review run, use **Agents → Restart with current agent settings**, or
`pnpm loom task restart <task> <runId>`. This retires the selected agent and creates a fresh
session on the same task/worktree, preserving its plan, findings and review round. It does not
transfer the old provider's conversation. Use `loom task show <task>` to find the current run ID.
The replacement waits for confirmed retirement; a stale run ID is rejected. Main and Operator retain their separate model settings.
Reasoning is persisted with the run, outbox action, and launch recipe and passed to both the
Codex thread and subsequent turns; the task's private TUI configuration receives it too.
Older runs without a reasoning field retain provider defaults. These are instance environment
settings; there is no desktop settings editor yet.

`LOOM_RUN_MODES` is a comma-separated per-role override such as
`planner=headless,reviewer=headless`. Planner, implementer, and reviewer all default to
`interactive`, giving every Loom-owned run a pane that can be attached. Partial overrides leave
unspecified roles interactive; only `interactive` and `headless` are accepted. Like provider and
model settings, this is captured when a new run row is created. Existing runs, retries/resumes, and
external sessions keep their recorded mode. Interactive planners and reviewers remain read-only,
and every interactive role's initial prompt travels through the provider-status send gate only after
the coordinator has recorded its provider session and pane.

When the coordinator restarts, it uses the same stable ports so that live runs' settings and MCP
config files remain valid.

## The protocol server

A WebSocket on `LOOM_BIND` (loopback by default) with `LOOM_TOKEN`, implementing `@loom/protocol`:
`hello`/`welcome`, a snapshot from the store plus the derived views, then patches after every
commit with sequence numbers **per connection** and contiguous, so a gap always means loss.
Subscriptions filter the stream; heartbeats drop a client that misses three; human commands are
recorded as inputs and acknowledged with their input ID. Frames are validated on the way out as
well as in.

`fetch_diff` and `save_review_state` answer `unavailable`: they belong to the Workbench, in
Phase 4, and the git adapter has no raw-patch reader yet.

## The CLI

`loom` is a protocol client and holds no state. `loom serve` and `loom repo add` are
instance-local admin commands that open the store directly. `loom task inspect` also reads the
store directly, using a read-only connection without migrations or startup recovery.

```sh
loom task list [--view needs_you]
loom task show <task>
loom task inspect <task> [--json]
loom task answer <task> <questionId> <answer>
loom task answer-request <task> <runId> <requestId> accept|decline|cancel
```

`task create <repo> <title> [description]` preserves the description exactly; quote it as
one shell argument. Use `--` before positional text that starts with `--`. The repository's
pnpm shell emulator keeps literal backticks and quotes intact when forwarding script arguments.
CLI errors include the error code, message, and each validator or guard detail on its own line.

`inspect` prints persisted task flags, all runs (newest last), message delivery history with
80-character text previews, open questions, pending plan/merge/provider approvals, the last ten
outbox rows with executor timestamps and results, and finding counts and open locations. Text
uses aligned columns without colour; `--json` returns the same data as one object. It works with
the coordinator stopped and reads the instance selected by `LOOM_INSTANCE` and `LOOM_DATA_ROOT`
(with the usual CLI environment). These are the last stored observations, not a live provider
refresh. No agents are contacted and no state is changed.

`answer-request` answers a provider's approval request (e.g., a Codex `command_approval` for a
test run). The decision is one of: `accept` (approve the operation), `decline` (reject it), or
`cancel` (cancel the operation). The `generation` field (for Codex threading) is read from the
run's current state in the snapshot.

Each per-task Codex app-server appends stderr to `<taskDirectory>/app-server.log` (created with
mode 0600). Startup logs the path; the file is preserved across restarts without rotation.

**Running it today:** no package in this repository emits JavaScript yet — everything is consumed
as TypeScript source by Vitest and by electron-vite — so `loom` needs a TypeScript-aware runtime
until a build step lands:

```sh
pnpm loom serve          # a root script over tsx, which is a workspace dev dependency
```

`main(argv)` is exported from `src/cli.ts`, so the command table is callable directly as well.

### Small task fast path

Small tasks (docs, typos, one-file fixes) skip the planning stage and reach `done` in ≤5 minutes when idle:

```sh
loom task create <repo> <title> [description] --small
```

Small tasks auto-generate a plan from the title (goal) and description (steps), then route directly from `todo` to `in_progress`, skipping the planning and plan_approval stages. The plan is marked as accepted, so no human approval is needed.

**Qualifying scope:** ~200 lines or fewer, single file, no architectural decisions. Docs, typos, comments, config updates, simple refactors.

**How it works:**
1. Task created with `--small` flag or `size: 'small'` via Main/Operator tools.
2. On first reconcile, a plan is auto-generated from task title (goal) and description (steps split by newlines).
3. Task transitions directly: `todo` → `in_progress` (no planning stage).
4. Implementer fixes it; reviewer runs only tests for affected packages.
5. Targets ≤5 minutes wall-clock from `todo` to `done` when idle.

### Timing measurements

Measure small task stage durations:

```sh
loom task timings <task>
```

Prints per-stage transition times from the audit log. Useful for verifying the ≤5-minute target and understanding latency bottlenecks.

## Troubleshooting

### Claude folder-trust dialog on first launch

**Symptom:** An interactive Claude run stops at the folder-trust dialog on first launch in a new
worktree.

**Cause:** Claude Code requires folder trust to open the worktree directory.

**Resolution:** Click the Trust button in Claude's dialog to allow access to the worktree.

### MCP `unknown_run` error

**Symptom:** An MCP tool call fails with `unknown_run`.

**Cause:** Codex registration lacked the bearer header in http_headers, preventing authentication
of MCP requests.

**Resolution:** Fixed; the coordinator now includes http_headers with the bearer token in all
Codex registrations.

### Codex reviewer stuck in `unknown` state

**Symptom:** A Codex reviewer gets stuck in `unknown` state and does not progress.

**Cause:** The reviewer's thread had no rollout, meaning the state machine did not transition.

**Resolution:** Fixed; the coordinator now rotates the session when `resumable=false`, ensuring
proper state transitions on resumable runs.

### Codex per-task home missing auth

**Symptom:** Codex cannot authenticate within the per-task home directory.

**Cause:** The `auth.json` file was not accessible in the per-task home.

**Resolution:** Fixed; the coordinator now links `auth.json` from `~/.codex` into each task's
home directory on startup.

### Run stalls on provider usage limit

**Symptom:** A run stalls and does not proceed, with the provider reporting a usage limit
reached (e.g., Claude rate limit).

**Cause:** The provider's API usage limit has been reached.

**Resolution:** The human can paste `continue` in an interactive run to retry the operation, or
wait for the provider's limit to reset before the next attempt.

## Recovery contract: panes and Codex sockets

### Pane persistence during recovery

When the coordinator restarts and finds a dead pane for a live run that still owns it, the pane is
relaunched from its recipe (the command line and environment). The new pane's info
(sessionName, windowId, paneId, hostGeneration) is immediately persisted to the run record before
any subsequent pane operation. This ensures pane-scoped sends target the new pane, not the old,
dead one.

**Idempotency:** If recovery is rerun on the same relaunched pane, the run record is updated to the
same pane info and is not duplicated.

### Recognizing pane recovery stalls

If a coordinator restart leaves a run observable-to-nobody but the pane is alive and working,
look for:

1. **Attention reason:** `observability_failure` or `status_unknown` (instead of a human-input wait like
   `provider_input`). The `observability_failure` reason specifically indicates the provider cannot be
   observed.
2. **Startup log:** `serve.log` shows `recovered: 0 recorded, 0 requeued, 0 Codex threads resumed, 1 panes relaunched`
   while the pane is alive and actively working.
3. **Provider status:** The run remains in `unknown` status even though the pane is running and the
   process is progressing.

**Cause:** The pane was relaunched but (a) its info was not persisted, causing pane operations to target
the dead pane, or (b) a Codex app-server socket issue prevented thread resume. See task t-d5033ac7 for
Codex socket probing and adoption behavior.

### Debugging pane persistence

Run `loom task inspect <taskId> --json` and check:
- `runs[].pane.windowId` and `runs[].pane.paneId` — should match the live pane (e.g., `@63`, `%63`).
- `runs[].status` — should be `working` or another live status if the pane is active and working.
- `runs[].unknownSince` — if this is set and holds for longer than `unknownGraceMs` (default 30s),
  the run will raise `observability_failure`.

If the recorded pane IDs do not match the live pane but the live pane is working, the run record was
not updated during recovery. Manually update the run record or restart the coordinator and check
recovery logs for errors.

## Tests

`src/*.test.ts`, against `@loom/fake-agent`'s providers, pane host and GitHub, a throwaway Git
repository with a real bare remote, and a fake clock. The real coordinator, executor, store, MCP
server and protocol server are used throughout; no agent, terminal or daemon is started.

- `e2e.test.ts` — the walking skeleton: Todo through plan, implementation, review, one fix round,
  approval and merge to Done, plus CI failing after approval and a human push.
- `faults.test.ts` — crash and retry, a dropped delivery, a duplicate event, a rate limit, a
  vanished interactive run, a blocking question.
- `restart.test.ts` — the coordinator killed between a push and its receipt.
- `gate.test.ts` — a run at a permission dialog receives no paste.
- `protocol.test.ts` — a fake client's snapshot, command ack, patches and a forced sequence gap.
- `cli.test.ts` — inspect text snapshots and JSON from a temporary fixture database, including history and missing tasks.
- `units.test.ts` — derived IDs, the environment allowlist, the config, `WORKFLOW.md`, the mapper.
- `real.test.ts` — opt-in (`LOOM_REAL_PROVIDERS=1`), one real headless Claude planner on `haiku`.
  GitHub stays faked: the merge half needs a throwaway GitHub repository this test cannot create.

```sh
pnpm test
pnpm lint
pnpm typecheck
```

## Permission allowlists

Interactive Claude implementer runs receive an automatically-derived permission allowlist for Bash
commands, so they execute approved project commands without stopping on permission prompts. This
allows implementers to work continuously without human intervention.

### Fixed allowlist

Every interactive Claude implementer run is pre-allowed these command prefixes:

- `git add` — stage changes
- `git commit` — commit staged changes
- `git status` — show repository status
- `git diff` — show uncommitted changes
- `git log` — show commit history
- `pnpm install` — install dependencies
- `pnpm exec vitest` — run tests
- `pnpm exec biome` — run formatter/linter
- `pnpm exec tsc` — run type checker

The following are **explicitly never allowed**, even if a workflow command references them:

- `git push` — coordinator handles merges through GitHub
- `git merge` — coordinator handles merges through GitHub
- `gh` — coordinator manages GitHub through its own adapter
- `rm` — prevents accidental data loss
- `curl` — hook communication uses its own curl; nested curl creates layering issues

### Derived from WORKFLOW.md

In addition to the fixed allowlist, any command defined in the repository's `WORKFLOW.md` is
converted to a `pnpm <name>` prefix and automatically allowed. For example:

```markdown
## test
```
pnpm test
```

## build
```
pnpm build
```
```

This WORKFLOW.md exposes commands `test` and `build`, which are converted to prefixes `pnpm test`
and `pnpm build` and included in the permission allowlist. The coordinator reads the file once per
run, so editing WORKFLOW.md in a worktree takes effect without restarting the coordinator.

**Note:** If WORKFLOW.md is malformed or missing, the run receives only the fixed allowlist and
continues without error. See [WORKFLOW.md policy](./README.md#workflowmd-design-note-133-settled-here) for details.

## Main

`open_lead_session` opens the instance's interactive Claude Main; `stop_lead_session` stops it and
revokes its token. `LOOM_MODEL_LEAD` defaults to `LOOM_MODEL_CLAUDE`. Its private recipe and settings
are in `<instance data>/lead/`, with cwd at the instance data directory. No task or run is created.
The configured stable MCP port takes precedence over the recipe; ephemeral instances reuse the
saved Main port across coordinator restarts. Recovery rewrites Main settings to the current
endpoint and relaunches only confirmed dead Main panes; absence requires an explicit open.
The internal `lead` identity and configuration names stay compatible. Main launches with Loom MCP
and only `Read`, `Glob`, `Grep` within its instance directory; shell, editing, web and subagent tools
are denied. Other MCP servers and terminal attach tools are unavailable to Main. Existing live
sessions keep their launch permissions until the human restarts Main.

Main introduces itself in two sentences and waits. On a subsequent panel open, the coordinator
requests a brief Needs-you summary only if native status is idle with no pending dialog. It never
pastes into a busy or waiting session, polls for a turn, or retries an uncertain summary delivery.
The Main-only `set_note({note})` tool atomically replaces `<instance data>/main-notes` (max 2,000
characters; empty clears it). Every launch includes this note as context, including session rotation.
See [the UI design](../../docs/design/ui.md#main) for controls and tool scope.

### Operator

The coordinator owns one event-driven Claude Operator, separate from task capacity and Main.
It starts lazily when attention, terminal run failures, pass/publish failures, or owned adapter
stale-process diagnostics arrive. It has only Loom MCP tools: no built-in tools or terminal.
`loom operator status [--json]` shows its session, queue, last ten decisions and rolling-hour count.
Protocol clients can send `open_operator_session` and `stop_operator_session`; stopping retains
queued events and persists stop intent. Opening enables event delivery, without a human chat turn.

Configuration accepts `operatorModel` (environment `LOOM_MODEL_OPERATOR`), defaulting to
`models.claude`. `operator.policy` accepts `"v1"`; its stable row IDs are in
`src/operator-policy.ts`. `operator.autoFix` defaults to `[]` and accepts `pass_failed`,
`publish_failed`, and `stale_process` (`LOOM_OPERATOR_AUTO_FIX`, comma separated).
`operator.maxFiledPerHour` defaults to 5 (`LOOM_OPERATOR_MAX_FILED_PER_HOUR`).

Set `operator.repoId` / `LOOM_OPERATOR_REPO` to the registered repository where runtime bugs belong.
No destination is inferred from the affected task. Without an explicit registered destination,
incidents remain queued and visible in Operator status until routing is configured. Bugs default
to backlog. Matching autoFix kinds receive a durable `todo` input in the same transaction as
creation; ordinary reconciliation starts their planners.

SQLite stores event hints, delivery attempts, processing receipts, command/retry ledgers, notes,
normalized signatures and quota records. Private session identity/settings live under
`<data>/<instance>/operator`. Repeated identical failures within an hour share an occurrence count;
separate events with equivalent normalized messages append evidence to one open bug. Terminal bugs
allow later recurrence. The sixth distinct new filing is suppressed and updates one instance
escalation note; duplicate signatures remain usable at quota.

Policy v1 never approves plans or merges. It only accepts freshly observed implementer permissions
for exact validated repository WORKFLOW commands or conservative simple `git add`, `git commit -m`
and `pnpm install` forms. Claude requires native permission command/request evidence; trust,
questions and unknown prompts escalate. A headless failure waits for core's retries, then permits
one `retry` command per task/role/round. That command resets the existing attempt budget; it does
not mean exactly one additional provider attempt.

Vanished clean committed implementation work can be rescued through guarded `push_branch` then
`open_pr` inputs. Both command evaluation and execution verify owner state. Rescue neither submits
an implementation nor changes its stage. Human escalation tags expire with their exact attention
occurrence. Tracker prioritizes tagged rows, offers a human-only filter, and displays authored notes
in Activity. Electron notification claims are deduplicated durably by the coordinator.

For constrained test hosts, `LOOM_TEST_SLOW_GIT=1 pnpm test --maxWorkers=1 --testTimeout=30000`
allows up to two minutes for coordinator Git scenarios. Normal deadlines, fake-clock assertions,
scenario step limits and UI performance budgets are unchanged.
