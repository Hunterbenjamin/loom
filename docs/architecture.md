# Loom architecture

This is the baseline design from 2026-09-11. Anything marked *(spike NN)* is an assumption that spike has to confirm.

## Goal

One fast place to:
- create tasks;
- watch agents work on them;
- step into their terminals;
- review and approve the results.

GitHub, Herdr, Codex and Claude Code keep working on their own, and anything done directly in them
shows up in Loom.

## Workflow

```
Backlog →(human) Todo →(auto) Planning →[valid plan] (optional plan approval) → In progress
→[submit_for_review + commits] In review →[blocking findings, round < 3] In progress
                                         →[no blocking findings]         Awaiting approval
→[human approves head SHA, CI green] Merging →[PR merged on GitHub] Done
```

Tasks can also be Canceled. Three things are tracked separately and must not be merged:
- the **issue stage** (the board column);
- the **agent run status** (working, idle, blocked, failed);
- **attention**: whether the task needs the human right now.

## Components

```
┌──────────── Dashboard (Electron renderer) ────────────┐
│ Linear-style UI · embedded terminals · diff review    │  no durable state
└──────────────▲ snapshot + patches over a local WebSocket
┌──────────────┴── Coordinator (launchd agent, Node/TS) ─────────────┐
│ SQLite (WAL) · reconciler · stage rules · run supervisor           │
│ MCP server for agents · adapters: git, GitHub, Herdr, Codex, Claude │
└──┬──────────────┬──────────────┬──────────────┬────────────────────┘
 GitHub     Codex daemon   Claude processes  Herdr server ── Ghostty / Herdr TUI
```

## Ownership

| Fact | Owner | Loom's copy |
|---|---|---|
| Task fields, stage, plans, findings, test results, approvals, run records | Coordinator (SQLite + artifact files) | Authoritative |
| Branches, PRs, CI, reviews, merge state | GitHub / local git | Cache with fetch time |
| Diffs | The worktree or the PR | Computed on demand |
| Session transcripts and live status | Codex daemon / Claude Code | Cache + references |
| Terminal processes | Herdr | References (pane IDs, agent names) |

Done is derived from GitHub: a task is Done only once its PR is merged.

## Synchronization

- **Reconcile from current state.** Every event enqueues `reconcile(taskId)`: hooks, app-server
  notifications, Herdr events, and changes found by polling GitHub. Reconcile re-reads from each owner,
  compares that with the desired state, and takes idempotent actions. A full resync runs about every 60 seconds.
- **One reconcile at a time per task.** Stage transitions are compare-and-set on a version column
  and are logged in a `transitions` table.
- **Join key: the worktree path.**
  - Claude hooks, Codex threads, Herdr panes and `claude agents --json` all report their working directory (`cwd`).
  - A branch maps to its PR.
  - Sessions started by hand inside a task's worktree attach to that task.
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
- **GitHub:** poll with conditional requests, because webhooks can't reach localhost.

## Agent integration

Each provider has four channels:

| Channel | Codex | Claude Code |
|---|---|---|
| **Control** | App-server over a unix socket: `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`; the coordinator answers approval requests. | Headless roles: Agent SDK or `claude -p --output-format stream-json`. Interactive: `herdr agent prompt`, `herdr agent send-keys esc`. *(spike 02)* |
| **Observe** | App-server notifications: `turn/*`, `item/*`, `turn/diff/updated`, `turn/plan/updated`, `account/rateLimits/updated`. | HTTP hooks posting to the coordinator (SessionStart, UserPromptSubmit, PermissionRequest, Notification, Stop, StopFailure, SessionEnd), plus `claude agents --json`; Herdr's state is a fallback. *(spike 02)* |
| **Attach** | A Herdr pane running `codex resume <thread> --remote unix://…`. *(spike 01)* | A Herdr pane, embedded via `herdr agent attach`; "take over" a headless run with `claude --resume <id>`. *(spike 03)* |
| **Signal** (agent → Loom) | Loom MCP tools | Loom MCP tools |

The Loom MCP tools are `get_task_context`, `submit_plan`, `report_progress`, `ask_human`,
`submit_for_review`, `submit_review(findings)` and `resolve_finding`. Their inputs are validated
against a schema before any transition.

Rules:
- Choose and record the session ID before launch: `claude --session-id <uuid>`, or the Codex thread ID
  returned by `thread/start`.
- Planners and reviewers run headless; the implementer runs interactively. A headless run can be
  handed over to a terminal, but never shared with one at the same time.
- Provider choice is a rule the human can override, for example "implement with one provider, review with
  the other". The planner may suggest a provider.
- Herdr's Claude and Codex integrations report session identity only, on SessionStart. Herdr works out
  working and blocked states from the screen, so it's only a fallback.

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

- One task = one branch = one worktree = one Herdr workspace.
- A `WORKFLOW.md` owned by each repo lists its setup, env bootstrap, test, lint, dev-server and teardown
  commands, plus its prompt templates.
- **Ports:** each task gets a slot (`PORT = base + slot*10`), written into the worktree's env. Dev servers run
  in Herdr panes.
- **Services and databases:** each task gets its own compose project or database name. If a repo can't
  support that, it's marked serial-tests and a lock guards its test step.
- **Dependencies:** "blocked by" links. A task starts only after its blockers are merged. No stacked PRs in v1.
- **Overlapping changes:**
  - The planner lists the areas it expects to touch, and the coordinator warns about overlap with active tasks.
  - After each merge, `git merge-tree --write-tree` flags branches that now conflict.
  - The agent rebases and re-runs tests before Awaiting approval.
  - Merges happen in approval order.
- **Caps:** a global cap (start at 4 agents) and a per-provider cap.

## Context handoffs

Agents hand off through artifacts, not transcripts. Each task's artifacts live in the coordinator's data directory.
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

- The reviewer runs in the worktree with editing disabled. It runs the tests and submits findings
  through MCP. Codex's `review/start` can add a second opinion. CI checks from GitHub are included.
- The diff view uses `@pierre/diffs`, with findings, human comments and CI annotations shown inline. It can
  show the whole branch or only the changes since the last review round. *(spike 04)*
- The coordinator records an approval against three things: the head commit, a snapshot of the findings, and the CI state.
  Any new commit voids it. "Request changes" turns the human's comments into blocking findings.
- Merging runs `gh pr merge --squash --match-head-commit <approvedSHA>`, or adds `--auto` while CI is still
  running. GitHub won't let you approve your own PR. If you want approvals to count on GitHub itself,
  have agents push as a bot or GitHub App identity.

## Reliability

| Failure | Handling |
|---|---|
| UI closed or crashed | Nothing happens. On reopen, the UI reconnects and gets a fresh snapshot. |
| Coordinator restart | 1. Load SQLite.<br>2. Scan worktrees, Herdr agents, loaded Codex threads, `claude agents --json` and PRs.<br>3. Resubscribe to events.<br>4. Resume runs that vanished using their stored session ID (N attempts). |
| Herdr or Codex daemon restart | Same process. Session IDs are what recovery relies on. *(spike 05)* |
| Agent failure | Detected via SessionEnd/StopFailure, a failed turn, or the pane exiting. Retry with `min(10s·2^(n−1), cap)` backoff; after 3 attempts, mark it blocked and notify the human. |
| Stall | No events for N minutes → set the attention flag. Don't kill it; the human may be typing. |
| Rate limits | Codex `account/rateLimits/updated` or Claude StopFailure → the provider is cooling down until its reset. Queue new work, and offer to switch providers only for runs that haven't started. |
| Duplicate or out-of-order events | Idempotent handlers, compare-and-set transitions, one reconcile at a time per task. |
| Review loops | At most 3 rounds. Escalate when a finding is reopened or the number of findings stops dropping. Each task has a time and cost budget. |

Out of scope: message brokers, event-sourcing frameworks, multi-machine support, sync engines,
plugins, a custom terminal emulator, a custom diff renderer.

## Stack

| Area | Choice |
|---|---|
| App shell and UI | Electron, React |
| Lists | TanStack Virtual |
| Board drag and drop | dnd-kit or Atlassian's pragmatic-drag-and-drop |
| Command palette | cmdk |
| Keyboard shortcuts | tinykeys |
| UI primitives | Radix |
| Terminal | xterm.js or ghostty-web *(spike 03)*, with node-pty |
| Diffs | `@pierre/diffs` |
| Storage | better-sqlite3 |
| Codex | TypeScript bindings from `codex app-server generate-ts` |
| Claude | `@anthropic-ai/claude-agent-sdk` |
| GitHub | `gh` / Octokit |

## Verified versus to be confirmed

**Verified.** Checked against docs and the CLI help of codex-cli 0.154, Claude Code 2.1.268, herdr 0.9.0 and gh 2.90 (Sept 2026):
- **Codex:** the app-server thread, turn and approval methods and the rate-limit events; the shared daemon; TUI `--remote`.
- **Claude Code:** `--session-id`; HTTP hooks and the event list above; background sessions and `claude agents --json`; Agent SDK resume and fork.
- **Herdr:** the socket API with `events.subscribe`; agent start, prompt, wait, read, send-keys and attach; `worktree create`; `report-agent-session`.
- **GitHub CLI:** `gh pr merge --match-head-commit`.
- **Pierre Diffs:** `@pierre/diffs` 1.4.2 (Apache-2.0), with annotations and a worker pool.
- **ghostty-web:** 0.4.0 (MIT), with the xterm.js API.

**To be confirmed** (see `spikes/`):
- **01:** the Codex TUI and another client sharing a live thread; where approvals go.
- **02:** status from Claude hooks; `herdr agent prompt` reliability; behavior when the hook endpoint is down.
- **03:** `herdr agent attach` embedded in Electron; renderer fidelity; opening in Ghostty.
- **04:** Pierre performance and annotation anchoring.
- **05:** what survives each kind of restart, and how to recover.
