# Brief: the Operator (event-driven, files bugs as tasks)

Read `AGENTS.md`, `docs/design/agents.md` (the layer contract; this brief implements its
"Operator" section and policy v1), `docs/design/core.md` §7 (MCP tools), `packages/mcp/src/lead.ts`
and `apps/coordinator/src/lead.ts` (the Lead session: the Operator mirrors it, headless). Open one
PR; update `docs/design/agents.md` in the same PR wherever the implementation diverges from it.

## Why

The first day of self-hosted use (2026-09-12) showed the layer that was missing. Every prompt an
implementer stopped on was answered by tmux keystrokes from outside Loom; every run that vanished
with committed work was rescued by hand (push the branch, open the PR); every bug the running
coordinator exposed (a reconcile pass failing on every tick, a task that could not be published to
any client, a stale app-server refused on restart, a leftover headless process holding a capacity
slot) was noticed by a human reading a log and turned into a task by a human writing it up. None of
that was visible in Loom and all of it kept the human from talking to the agent they meant to talk
to.

The Operator is the agent that does those things, and the one thing the human named as its job
beyond the policy table: **when a bug is discovered from the app running, the Operator files the
task, which starts a planner, with no human in the middle.**

## Model (decided; do not redesign)

- **One coordinator-owned headless Claude session per instance.** Like the Lead but with no
  terminal: run through the Agent SDK (`packages/adapters/claude` headless path), recipe under
  `<data>/operator`, per-session settings and MCP config written on every launch, relaunched by
  recovery like the Lead's session. Model `LOOM_MODEL_OPERATOR` (config `operatorModel`), defaulting
  to the configured Claude model.
- **Woken by events, never by a human.** The coordinator emits structured events (a typed
  `OperatorEvent`, not log parsing) and the Operator's turn starts with them:
  - a Needs-you row appears or changes (any attention reason, design §3);
  - a run ends with `vanished`, `crashed` or `retries_exhausted`;
  - a reconcile pass fails for a task (`Pass for <task> failed: …`);
  - a publish to clients fails for a task (`Could not publish <task>: …`);
  - a stale process report from an adapter (an app-server or headless child that outlived its run).
  Events for one task are coalesced into one turn; a turn that is already running receives the new
  events at its next tool call rather than starting a second turn.
- **Acts only through Loom commands.** Its MCP identity is `operator`, gated like the Lead's
  (`packages/mcp`): the lead tool set (`list_tasks`, `inspect_task`, `create_task`, `move_task`,
  `approve_plan`, `reject_plan`, `approve_merge`, `request_changes`, `answer_question`,
  `answer_provider_request`, `retry_task`, `cancel_task`, `list_repos`) plus `answer_pane_prompt`,
  `file_task` and `append_note`. Every call is a human-command input on the task and appears in its
  activity. It has no shell, never attaches to a pane, never merges; `approve_merge` is present for
  later policy rows and refused by policy v1.

## Policy v1 (conservative)

The policy lives in coordinator config (`operator.policy`), every row is a test, and every decision
the Operator takes is a note on the task naming the row it applied.

| Situation | Decision |
|---|---|
| Implementer stopped on a prompt for a `WORKFLOW.md` command, `git add`, `git commit`, `pnpm install` | Answer yes (`answer_pane_prompt` / `answer_provider_request`) |
| Prompt for any other command | Escalate with the command text |
| Headless run failed | `retry_task` once; a second failure escalates |
| Run vanished with committed work and no submission | Push the branch and open the PR as the coordinator would (a `push_branch` + `open_pr` command the Operator is allowed to send), note the task |
| Run vanished with uncommitted work | Escalate |
| Reviewer round cap reached, or the same finding raised twice | Escalate with both rounds' summaries |
| Plan needs approval | Escalate; never approves |
| Merge approval | Escalate; never approves |
| Coordinator bug event (pass failed, publish failed, stale process) | `file_task` (below) |
| Anything else | Escalate |

**Escalation** = the Needs-you row tagged `for human` (a new field on attention rows, design
§"Consequences") with a one-paragraph summary Main can relay, plus a note on the task with the
Operator's reasoning. A tagged row raises a desktop notification through the existing path.

## Filing bugs: `file_task`

Input: a **failure signature** (`kind` + normalized message with ids, paths, timestamps and numbers
replaced by placeholders + the task and run ids involved), the **evidence** (the event, the last
relevant coordinator log lines the event carried, and the task and run state from `inspect_task`
`--json`), and a proposed title and description in the style of the repository's existing tasks.

- **Dedupe by signature.** An open task with the same signature (stored on the task) gets the new
  evidence appended with `append_note`; a second task is never created. Signatures are compared
  after normalization, so two tasks hitting the same publish error share one filed task.
- **Backlog by default.** A filed task lands in `backlog`; a signature matching an entry in
  `operator.autoFix` (config, a list of signature kinds) is moved to `todo` immediately, which starts
  a planner with no human in the loop.
- **Rate limit.** At most `operator.maxFiledPerHour` (default 5) filed tasks per hour per instance;
  beyond that the Operator escalates once ("filing paused, N events since") and appends further
  evidence to that escalation's note.
- The filed description must include the signature, the evidence, and the acceptance test the
  planner should write for it; the Operator does not propose a fix.

## What to build

1. `apps/coordinator/src/operator.ts`: session lifecycle mirroring `lead.ts` (recipe, token,
   settings, launch through the headless adapter, `open_operator_session` / `stop_operator_session`
   commands, recovery relaunch), the event queue and coalescing, delivery of events as the turn's
   input.
2. Structured `OperatorEvent`s emitted by the coordinator for the triggers above, including the
   pass-failure and publish-failure paths that today only `log`.
3. `packages/mcp`: the `operator` identity and gating, `file_task` and `append_note`; the Operator's
   first message (`prompts.ts`) stating its job, its tools and that it never merges or approves.
4. Core and protocol: the task note entity (design §"Consequences"), the `signature` field on tasks,
   the `for human` tag on attention rows, the `push_branch`/`open_pr` human commands.
5. Config: `operatorModel`, `operator.policy`, `operator.autoFix`, `operator.maxFiledPerHour`,
   documented in `apps/coordinator/README.md`.
6. Visibility: the Operator's actions appear in each task's Activity; an "Operator" row in the
   Tracker's Needs-you area shows its last action and when; `loom operator status` in the CLI
   prints session state, queue length, last ten actions, filed-task count this hour.

## Tests

- Policy table: with the fake agent, every row above → the exact command the Operator sends (or
  the escalation), one test per row.
- Dedupe and rate limit: two events with one signature → one task with two notes; the sixth event
  in an hour → one escalation, no task.
- Coordinator: a `Pass for <task> failed` event ends in exactly one filed task in `backlog`; with
  its kind in `operator.autoFix`, in `todo` with a planner run started.
- Identity gating: an operator token cannot call task-run tools; a run token cannot call
  `file_task`; a lead token cannot call `file_task`.
- Recovery: the Operator session survives a coordinator restart with its queue drained, not lost.

## Rules

- Do not change stage rules or the reconciler's decisions beyond the note entity and the tag.
- Never run the stable instance, never touch the user's tmux server or global config; tests use the
  fake agent and `loom-test-<pid>` sockets.
- Performance budgets in `docs/design/ui.md` hold for the Tracker changes.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. Say in the PR which policy rows are covered by
  tests and which parts of `docs/design/agents.md` you changed.
