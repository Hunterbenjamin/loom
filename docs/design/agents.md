# Agent layers

Terminology: an “issue” in the UI is a “task” in the code; internal identifiers and MCP tool names retain `task`.

Who talks to whom, who decides what, and who is allowed to be busy. This note records the direction
agreed on 2026-09-12 and updated by the 2026-09-13 decision to remove the Operator. It builds on the principles in [`AGENTS.md`](../../AGENTS.md) and the
contract in [`core.md`](core.md); core owns the stage rules.

## What the first day showed

- One agent (the Claude Code session that built Loom) played three roles at once: the one the human
  talks to, the one that handles what agents need, and the one that reviews PRs. Whenever it was doing
  the second or third, the human could not talk to it, which is the problem Loom exists to solve.
- The Lead panel (PR #56) inherited the same shape and, left alone, spent twenty minutes running a
  "restart drill" of its own devising instead of being available.
- Every prompt an implementer stopped on (`pnpm test`, `git commit`, folder trust) was answered by
  tmux keystrokes from outside Loom. Nothing recorded them; the human saw neither the prompt nor the
  answer.

The fix is a separation the human named: the agent you talk to must never be the agent that is busy.

## Layers

| Layer | Kind | Job | May be busy? |
|---|---|---|---|
| **Human** | | Direction, approvals that are theirs, questions only they can answer | |
| **Main** | Interactive Claude session, one per repository, behind the bottom-bar toggle | The conversation: understand intent, turn it into issues, summarize what is going on, ask the human what is actually theirs | Never: no action longer than a few seconds |
| **Coordinator** | Code (`apps/coordinator`, `packages/core`) | Stages, launches, review rounds, merges on approval, recovery | Always; it is a process |
| **Issue agents** | Planner, implementer, reviewer runs (unchanged) | The work of one issue, one role at a time | Yes |

### Reviewers fix actual problems inline

Reviewers have worktree write access, including commits on the task branch, in both launch modes
and for both providers. Run the tests and read the diff against the accepted plan and AGENTS.md.
Most reviews should find nothing to change. Do not fix things just because you can; never restyle,
refactor or expand scope. Fix only an actual bug, a failing or missing test required by the plan,
or an AGENTS.md violation. Commit each fix separately with a message naming the finding, and rerun
the relevant tests.

Submit the clean HEAD through `submit_review`, listing every commit after the round head in
`reviewerCommits`. A fixed finding/verdict uses `status: fixed` and its `commitSha`. Escalate only
what cannot be fixed safely inline: a design change, unanticipated work, or work across many files.
Use `status: escalate` and explain why in `reason`. Everything else is fixed or reported as
non-blocking; severity alone never requests an implementer fix round. Provide verdicts for earlier
addressed/disputed findings and any remaining open blockers.

The coordinator validates ancestry and the complete commit list, records the authenticated
submission, and pushes the reviewed head before opening the PR. Reviewers do not move cards or
merge. A successful submission may return `next: in_review` while publication is pending; this is
completed reviewer work, not a request to submit again. Only an explicit escalation invokes the
implementer's automatic fix-round path; the cap and nonconvergence checks still apply.

### Main has no hands

The selected project determines the Main shown in the bottom panel. Each repository owns a
separate session, recipe, settings, token and notes under `<instance data>/lead/<repoId>/`, with
cwd at its root and workspace `lead-<repoId>` (`loom-lead-<repoId>`). Open/stop commands and attach
targets carry `repoId`. Switching projects opens Main lazily and detaches only the old viewer.
The coordinator recovers every recipe on startup. The legacy single recipe migrates idempotently
to the first registered repository, keeping its persisted session ID and token.

Main's authenticated tools default to and enforce its repository: list/inspect/create/move/approval
and other task commands cannot reach another project's tasks. Its introduction names the repository.

Main's availability is enforced by what it cannot do, not by asking it to be quick:

- No shell, no terminal attach, no test runner; only read-only file tools within its repository.
- Only Loom tools, each answering in under a second: list and inspect issues, create and move
  them, approve or reject a plan, approve a merge the human has delegated, request changes, answer a
  question, answer a provider request, retry, cancel, list repositories.
- Anything longer becomes an issue. "Can you look into why the reviewer is
  stuck" is an issue or an escalation, never something Main does itself.

Main launches with only `Read`, `Glob`, `Grep` and Loom MCP tools. `--disallowedTools` denies
`Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` and `Task`;
restricted mode confines file reads to the repository, and strict MCP configuration
excludes other servers (including terminal attach tools). The panel remains a human view of
Main's conversation. Its first response is a two-sentence introduction, then it waits; it never
starts drills or resumes work on its own. Internal `lead` identifiers remain for compatibility.

### The Coordinator stays code

The orchestrator the human described, "planning agents → implementer agents → review agents → back
to the orchestrator", is the reconciler. It is deterministic, restart-safe and tested; an LLM in its
place would be slower and less reliable, and principle 3 ("code moves issues between stages") exists
for exactly this reason. Auto-merge is therefore a **policy flag on the coordinator**, per
repository with a per-issue override:

| `merge.approval` | Meaning |
|---|---|
| `always` | A human approves every merge (today's behaviour). |
| `clean-review` | The coordinator merges when the reviewer submits with no findings and CI is green; otherwise a human. |
| `never` | Loom never merges; the human merges on GitHub and Loom observes it. |

No agent decides to merge. Main can only *approve* within what the human has
delegated to it, and every approval is an input on the issue like any other.

## How the layers communicate

Main may message agents fire-and-forget through Loom; every message is recorded; Main never waits.
Messages are short questions or heads-ups, never a way to drive work; work becomes an issue.
This is the user decision of 2026-09-13. Everything goes through Loom, so it is persisted and visible:

| From | To | Channel |
|---|---|---|
| Human | Main | The bottom-bar panel |
| Main | Coordinator | Loom commands (create, move, approve, answer) |
| Main | Issue agents | `message_agent`: an issue note authored `main`, then the core message path and provider-confirmed receipt; unavailable or waiting runs are refused |
| Coordinator | Everyone | Snapshot and patches (protocol) |

When the human is not looking, a `for human` row raises a desktop notification. When they open the
panel, nothing is sent to Main (decision 2026-09-13: opening a terminal is looking, not asking). Main summarizes the rows when the human asks, from the same snapshot.

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

## Main persistence

Main keeps one Loom-held `main-notes` document per repository under `lead/<repoId>/`, replaced
through `set_note({note})` (max 2,000 characters; empty clears it). Each launch includes that
context without authorizing work. Sessions, settings and credentials survive coordinator restarts.
`message_agent` accepts only an exact task/run or a task/role. Main's authored notes and idempotent
receipts are stored separately from task-run message delivery; there is no Operator reply channel.

## Out of scope

- A Main shared across repositories or instances.
- Unrecorded agent chat, synchronous conversations or using messages to assign work.
