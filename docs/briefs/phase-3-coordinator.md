# Phase 3: `apps/coordinator`, the walking skeleton

**Agent:** claude, Opus · **Branch:** `feat/coordinator` · **PR title:** "Phase 3: coordinator and
the `loom` CLI" · **Timebox:** about 4 hours from your first commit; approval waits don't count.
Read [`phase-2-common.md`](phase-2-common.md) for the shared rules, then `docs/architecture.md`,
`docs/design/core.md` §5, §8 and §10, `docs/design/ui.md`, and the READMEs of `packages/store`,
`packages/mcp`, `packages/protocol`, `packages/fake-agent` and `packages/adapters/tmux`. Every
contract you need already exists; this phase wires them together and adds no new rules.

## Why

Everything so far is a part. The coordinator is the process that runs them: it loads state, reads
the owners, runs `reconcile`, commits, executes actions, hosts the MCP server agents call, and
serves windows. Its milestone is the build plan's walking skeleton: one task on a repo goes from
Todo through plan, implementation, review, one fix round, human approval and merge, and a restart
mid-run recovers. After that, Loom files its own work as Loom tasks.

## Build

`apps/coordinator`: one long-running process per instance (`LOOM_INSTANCE`, `LOOM_DATA_ROOT`), and a
`loom` CLI that talks to it. No UI work; the Tracker and Workbench connect in Phase 4.

1. **The loop.** Per task, at most one pass at a time; passes are enqueued by adapter hints
   (`subscribe` on every adapter and the pane host), new inputs, `schedule` actions, and a full
   resync about every 60 s. A pass: `store.loadTaskState` → fresh observations (git, GitHub with
   its ETag, each live run through its provider adapter plus the pane host, external sessions
   joined on realpath, capacity and dependencies from the store's cross-task reads,
   `store.pendingInputs`) → `reconcile` → `store.commit(taskId, result, state.task.version)`. On a
   conflict, reload and retry up to three times, then re-enqueue. Respect the store's one input
   per pass default; don't raise it.
2. **The executor.** Claims outbox rows (`store.outbox.claim`, rechecking `isClaimCurrent` before
   any side effect), maps every `Action` kind to the adapter that owns it, and records the result
   with `store.outbox.finish` as an `action_result` input. Every executor checks the owner before
   acting, as the design's at-least-once rule requires: an existing worktree, an existing PR, a live
   session under that ID, a remote head already at the SHA.
3. **Launching a run.** Persist the whole launch recipe before anything starts: the derived Claude
   session ID (inject the UUIDv5 and sha256 functions into `ReconcileConfig`), an unguessable per-run
   MCP token, the per-run settings and MCP config files written with mode `0600` outside the
   repository (the Claude adapter writes them; the token rides in `LOOM_MCP_TOKEN` and the MCP
   config, never in `--settings`), the environment allowlist, cwd, executable and args. Then
   `paneHost.ensurePane` for interactive runs, the Agent SDK for headless ones, and one Codex
   app-server per task through `codexAdapter.startServer`, outside the pane host.
4. **The send gate.** Before any `pasteText`, the provider's current status must permit it: never
   while it is waiting on a permission or a question, and never while it is `unknown`. Spike 06
   showed a paste into a permission dialog approves the command. Delivery is confirmed only by the
   provider (`UserPromptSubmit`, `turn/started`, or the user-message item for a steer); a message
   unconfirmed after `deliveryTimeoutMs` is resent once with the same message ID if the provider is
   idle, otherwise it raises attention. Never resend into uncertainty.
5. **The MCP host.** `serveHttp` from `@loom/mcp` with an `McpHost` over the store and the loop:
   `submit` persists the input, runs one pass for its task, and answers with that input's
   disposition; `context` builds `GetTaskContextOutput` role-filtered, including the repo's
   `WORKFLOW.md` commands (load and validate it here; this is design note 13.3); `resolveToken`
   consults current run state on every call; `buildAnchor` reads the reviewed blobs through the git
   adapter, never the working file.
6. **Prompts.** The planner, implementer and reviewer briefs are templates in the coordinator, filled
   from the task's artifacts, and every fix-round message includes the findings projection. Keep
   them short and point agents at `get_task_context` for the rest.
7. **Recovery on startup**, per design §10: load state; `store.outbox.startupRunning` and, for each
   row, check the owner then `requeue` or record the recovered result; `thread/resume` every live
   Codex run; poll `claude agents --json`; relaunch interactive runs whose pane is dead from the
   stored recipe; reconcile every non-terminal task.
8. **The protocol server.** A WebSocket on `LOOM_BIND` (loopback by default) with `LOOM_TOKEN`,
   implementing `@loom/protocol`: `hello`/`welcome`, a snapshot from the store plus the derived
   views (changed files through the git adapter, `deriveAttention` from core, run targets from the
   pane host), patches after every commit with per-connection sequence numbers, subscriptions,
   heartbeat, and commands recorded as inputs and acknowledged with their input ID. The desktop
   app isn't wired to it in this phase; a fake client in the tests is.
9. **The `loom` CLI.** `loom serve`, `loom status`, `loom task create|list|show|move|approve-plan|
   reject-plan|approve|request-changes|answer|retry|cancel`, and `loom attach <task> [role]`, which
   prints or execs the pane host's attach command. The CLI is a protocol client; it holds no state.

## Tests

- **End to end on `@loom/fake-agent`**, with a temporary store and a throwaway git repo: the design
  §9 scenario runs Todo → Done through the real coordinator, executor, MCP server and store, with
  the GitHub adapter faked. Add the scenarios fake-agent ships: crash and retry, dropped delivery,
  duplicate event, rate limit, human push, CI failure after approval, a vanished interactive run.
- **Restart mid-run:** kill the coordinator between an action's execution and its result, restart,
  and show the run recovers without repeating the action.
- **The send gate:** a run at a permission dialog receives no paste.
- **Protocol:** a fake client connects, gets a snapshot, sends a command, receives the ack and the
  resulting patches, and detects a forced sequence gap.
- **Opt-in real run** (`LOOM_REAL_PROVIDERS=1`): the walking skeleton on a throwaway repository with
  a throwaway GitHub repo, cheapest models, one task, one fix round. Record what happened in the PR.

## Out of scope

The desktop app, the Workbench, ports and dev servers, overlap warnings, issue import, and any
change to `packages/core`'s rules. If a contract turns out to be missing something, list it under
"Contract changes" with the smallest addition that unblocks you.
