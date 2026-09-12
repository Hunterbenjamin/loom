# Agent layers

Who talks to whom, who decides what, and who is allowed to be busy. This note records the direction
agreed on 2026-09-12 after the first day of self-hosted use; the Operator brief and the Lead PR
follow-ups derive from it. It builds on the principles in [`AGENTS.md`](../../AGENTS.md) and the
contract in [`core.md`](core.md); nothing here changes a stage rule.

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
| **Main** | Interactive Claude session, one per instance, behind the bottom-bar toggle | The conversation: understand intent, turn it into tasks, summarize what is going on, ask the human what is actually theirs | Never: no action longer than a few seconds |
| **Coordinator** | Code (`apps/coordinator`, `packages/core`) | Stages, launches, review rounds, merges on approval, recovery | Always; it is a process |
| **Operator** | Headless agent session, one per instance, coordinator-owned | Everything that needs judgement but not the human: consume Needs-you rows under a policy, act through Loom commands, escalate the rest | Yes, for minutes, unnoticed |
| **Task agents** | Planner, implementer, reviewer runs (unchanged) | The work of one task, one role at a time | Yes |

### Main has no hands

Main's availability is enforced by what it cannot do, not by asking it to be quick:

- No shell, no terminal attach, no test runner, no file system outside its own data directory.
- Only Loom tools, each answering in under a second: list and inspect tasks, create and move
  them, approve or reject a plan, approve a merge the human has delegated, request changes, answer a
  question, answer a provider request, retry, cancel, list repositories.
- Anything longer becomes a task or a note for the Operator. "Can you look into why the reviewer is
  stuck" is a task or an escalation, never something Main does itself.

The Lead PR's tool set already matches this list. What it must lose is every other capability the
session inherits from Claude Code: the per-session settings deny `Bash`, `Edit`, `Write` and the
attach path, so the panel cannot drift into work even when asked.

### The Coordinator stays code

The orchestrator the human described, "planning agents → implementer agents → review agents → back
to the orchestrator", is the reconciler. It is deterministic, restart-safe and tested; an LLM in its
place would be slower and less reliable, and principle 3 ("code moves tasks between stages") exists
for exactly this reason. Auto-merge is therefore a **policy flag on the coordinator**, per
repository with a per-task override:

| `merge.approval` | Meaning |
|---|---|
| `always` | A human approves every merge (today's behaviour). |
| `clean-review` | The coordinator merges when the reviewer submits with no findings and CI is green; otherwise a human. |
| `never` | Loom never merges; the human merges on GitHub and Loom observes it. |

No agent decides to merge. The Operator and Main can only *approve* within what the human has
delegated to them, and every approval is an input on the task like any other.

### The Operator

The layer the first day was missing. It is a headless session the coordinator owns, like the Lead's
but without a terminal, woken by events rather than by a human:

- **Trigger:** a Needs-you row appears or changes (attention reasons, design §3), a run ends with
  committed work and no submission, a review round closes, a PR's checks change.
- **Acts only through Loom commands**, the same ones the CLI sends, so every action is an input
  recorded on the task and visible in its activity. It never touches tmux, git or GitHub directly.
- **Reviews the task, not the code.** The reviewer run judges the diff. The Operator judges the
  loop: did the rounds converge, is the PR mergeable, is the plan still what was approved, should
  the human look. Its verdict is a note on the task and, when needed, an escalation.
- **Escalates per policy** by tagging a Needs-you row `for human`. Rows without the tag are its
  own queue.

## How the layers communicate

Main and the Operator never talk to each other directly, and neither talks to a task agent outside a
task. Everything goes through Loom, so it is persisted and visible:

| From | To | Channel |
|---|---|---|
| Human | Main | The bottom-bar panel |
| Main | Coordinator | Loom commands (create, move, approve, answer) |
| Main | Operator | A note on a task ("look at why the reviewer keeps raising this") |
| Operator | Task agents | Loom commands: answer a request, send a message, retry |
| Operator | Human | A Needs-you row tagged `for human`; a note on the task with its reasoning |
| Operator | Main | Nothing direct; Main reads the same rows and notes when the human opens the panel |
| Coordinator | Everyone | Snapshot and patches (protocol) |

When the human is not looking, a `for human` row raises a desktop notification. When they open the
panel, Main summarizes the rows since they last looked, in its own words, from the same snapshot.

## Operator policy v1

Conservative on purpose. The policy is where the risk lives: an over-eager Operator merges junk, an
under-eager one asks the human everything. It starts narrow and widens as trust is earned.

| Situation | v1 decision | Widens to |
|---|---|---|
| Implementer stopped on a permission prompt for a `WORKFLOW.md` command, `git add`, `git commit` or `pnpm install` | Answer yes | Any command the repository's allow list names |
| Prompt for any other command | Escalate `for human` with the command text | Answer yes for read-only commands |
| Codex approval request for a workflow command | Accept | Same |
| Headless run failed | Retry once; second failure escalates | Retry up to the configured cap |
| Run vanished with work committed and no submission | Push the branch, open the PR as Loom would have, note the task | Same |
| Run vanished with uncommitted work | Escalate `for human` | Relaunch from recipe when the pane host reports the pane dead |
| Reviewer raises the same finding twice | Escalate `for human` with both rounds' summaries | Request changes with a consolidated note |
| Review round closes with no findings | Note "ready for approval" on the task; escalate `for human` | Approve the merge when `merge.approval` is `clean-review` |
| Merge approval | Never | Within a human-delegated scope (repo, label, size) |
| Plan submitted | Never approves | Approve plans for tasks the human marked routine |
| Anything unlisted | Escalate `for human` | |

Every decision the Operator takes is a note on the task naming the policy row it applied, so the
human can audit it and widen or narrow the row.

## Consequences for existing work

- **Lead PR (#56):** keep the tool set; deny `Bash`, `Edit`, `Write` and attach in the Lead's
  generated settings; rename the session and panel from Lead to Main in the next UI pass. The Lead
  brief's rule "always create tasks rather than editing repositories" becomes enforced rather than
  requested.
- **Operator:** a new coordinator-owned headless session, launched and recovered like the Lead's
  (recipe, per-session settings, stable MCP registration), with a lead-style MCP identity of its
  own so its tools are the human commands and nothing else. It gets the `provider_input` /
  `provider_permission` rows first, since those are what a human answered by hand all day.
- **Notes on tasks:** a small addition to core and the protocol, an authored text entry on a task
  from Main, the Operator or a human, shown in activity. This is the only new entity the design
  needs.
- **Needs-you rows** gain a `for human` tag; the inbox shows tagged rows first and lets the human
  filter to them.
- **Main's memory:** the Claude session resumes across restarts, which covers days. For longer,
  Main keeps one Loom-held summary note per instance, rewritten when the human's priorities change,
  and reads it on start.
- **Restarts:** Main and the Operator survive a coordinator restart the way runs do (stable ports,
  settings rewritten in recovery); neither holds state the coordinator does not.

## Out of v1

- An Operator that plans work on its own initiative. It reacts to rows; Main and the human decide
  what to build.
- More than one Main per instance, or a Main shared across instances.
- Agent-to-agent chat of any kind outside a task's recorded channels.

## Operator implementation contract

Operator v1 now also consumes structured `pass_failed`, `publish_failed` and `stale_process`
diagnostics, plus attention and ended-run hints, independently of desktop publication. Owned
adapter diagnostics are emitted at their source; no terminal or log parsing is involved. Duplicate
hints cannot duplicate actions. Identical runtime failures within an hour retain occurrence counts.
Events that arrive during a turn are returned at the next MCP call, or included in the next turn
following the SDK's native result. Delivery attempts are distinct from processing receipts: only
durable decisions acknowledge processing.

The identity is an MCP-only headless Claude session. Its recipe/token is saved before launch;
settings and MCP registration are rewritten at launch, and resume requires provider confirmation.
If that identity is still live without a local owned-child handle, recovery refuses a duplicate
launch and exposes an error. Stop intent, event queue, retry ledger, filing quota and notes survive
restart. Operator failures do not produce recursive Operator events.

Policy row identifiers are `permission.allowed`, `permission.other`, `headless.retry`,
`headless.exhausted`, `vanished.rescue`, `vanished.uncertain`, `review.escalate`, `plan.approval`,
`merge.approval`, `bug.file`, and `fallback`. The coordinator chooses command arguments from fresh
owner observations. Operator cannot choose a different branch, approval request, epoch or response.
Approval and generic task-creation/move tools remain visible but are refused. `append_note` records
an enforced escalation decision; it is not a general-purpose task-editing escape hatch.

Rescue uses the `push_branch` and `open_pr` human-command/outbox path, with clean recorded HEAD,
vanished implementation, no live run, no accepted submission and confirmed push guards. It never
fabricates a submission or advances a stage. The retry row means one Operator-issued retry budget
reset per role and review round, after core's automatic attempts are exhausted. Core retry rules
are unchanged. Claude permission automation requires native PermissionRequest command and request
identity; generic PreToolUse, trust and question signals are not sufficient evidence.

`file_task` accepts a persisted event ID, title, observed-failure description and acceptance test.
The coordinator adds bounded sanitized event/inspection evidence and a versioned normalized
signature, deduplicates across affected tasks, and atomically creates backlog work plus any autoFix
`todo` input. The description must state a failure and acceptance test, not a proposed fix. New-task
quota accounting happens after dedupe. Suppressed filings update one stable escalation note.
Runtime repository routing is explicit (`operator.repoId`); unresolved/taskless incidents remain
visible rather than being silently assigned to an affected repository.

Notes include authenticated author, policy row, event/action correlation, outcome and occurrence.
Tracker shows Operator status and decisions, prioritizes/filter human-tagged rows, and Activity
shows notes. Tags project only while their attention occurrence remains current. Notification
claims are persisted in SQLite to prevent duplicate notifications across windows and restarts.
The Lead-to-Main rename, general note editing, memory and broader approval policies remain separate
work; the Operator does not expand Lead's built-in capabilities.
