# Agent layers

[AGENTS.md](../../AGENTS.md) owns repository principles and safety. [Core workflow](core.md) owns
stage transitions; agents submit structured results and never move stages themselves.

| Actor | Responsibility |
|---|---|
| Human | Direction, authorization, questions and final decisions |
| Main | Act on the human's requests and organize larger work into issues |
| Coordinator | Deterministic workflow, launches, recovery and guarded external actions |
| Issue agents | Plan, implement or review one issue in a recorded role/run |

## Issue agents

The executable brief templates are in [prompts.ts](../../apps/coordinator/src/prompts.ts), and
submission validation is in [core/submissions.ts](../../packages/core/src/submissions.ts) and
[MCP schemas](../../packages/mcp/src/schemas.ts).

- **Planner:** investigate the cause and propose decisions, not code-level instructions. Target
  300–600 words; the enforced cap is 800. Steps are one-line outcomes (up to 200 characters each),
  with at most eight observable acceptance criteria. Include goal, non-goals, areas, a brief test
  plan, risks and questions. Do not invent requirements. Planners have read-only launch restrictions.
- **Implementer:** meet acceptance criteria, fix causes and record material departures from the
  plan. Tests are evidence of behavior; update a test when the intended behavior changes rather
  than preserving an obsolete design. Commit and submit. Run only test files covering the change;
  lint, typecheck, full suites, builds and other scripts belong to CI unless the plan asks for them.
- **Reviewer:** inspect the submitted diff against the issue, acceptance criteria and principles.
  Judge logic, edge cases, ownership and whether tests prove the intended behavior. CI has already
  passed (or the no-check grace has elapsed); run a test only to confirm a suspected bug. Never edit
  or commit, even though launch access permits it. Escalate real bugs, principle violations, unmet
  acceptance criteria, hidden causes or duplicate definitions. Optional improvements are notes.

Review submissions name the round head and have an empty `reviewerCommits`. `fixed` findings and
verdicts are rejected. Blocking findings use `escalate` with a reason; `open` is non-blocking,
regardless of severity. Later reviews inspect changes since `worktree.lastReviewedHead` and give
required verdicts on addressed/disputed findings and open blockers. Publication can remain pending
after a successful submission; that does not call for another submission.

### Context and fix rounds

Call `get_task_context` first. Each run session epoch gets a full role view on its first read;
subsequent reads return changed sections and must-act findings. Read again when Loom reports state
changed; `{full: true}` requests the whole view. Read markers are in memory, so coordinator restart
safely causes another full response.

Cross-role context travels through coordinator artifacts, not provider transcripts: brief, accepted
plan, decisions, findings, test evidence and handoff. `.task/` mirrors are kept out of Git. The
[store](../../packages/store/README.md#artifacts-and-migrations) owns durable versions.

CI failures, blocking review/human findings and base conflicts start fresh implementer fix-round
sessions. The previous run retires before the replacement launches in the same worktree. Context
contains the reason, findings and base-to-HEAD diff; the diff is capped at 60 KiB and supplies a stat
and exact Git command when truncated. Retries/recovery resume that fix run's captured session;
they do not create another fix round. Reviewers also start fresh per round.

## Main

Main is one interactive Claude session per repository, separate from issue runs. It launches at the
repository root with broad machine access, including shell, files, web and subagents. It can act on
the human's request or create issues for work needing tracking and review. It introduces the
repository and waits; launch notes do not authorize maintenance or drills. Issue scoping follows
the review question: batch related mechanical work, separate judgment calls and structural changes.

**Existing instruction conflict:** [prompts.ts](../../apps/coordinator/src/prompts.ts) permits Main
to read and repair the coordinator's log/store directly when asked. [AGENTS.md](../../AGENTS.md#safety)
requires access to a running Loom instance through the supplied MCP tools. The broad launch is
implemented in [lead.ts](../../apps/coordinator/src/lead.ts); it is not an exception to that repository
rule. This documentation update preserves AGENTS.md and does not resolve the permission conflict.

Internal `lead` names remain compatibility identifiers: commands such as `open_lead_session`,
`LOOM_MODEL_LEAD`, and private `lead/<repoId>/` recipes. Each repository has its own session ID,
token, settings and `main-notes`. Switching projects retargets the viewer without stopping the old
session. Startup recovers saved recipes; confirmed dead panes may relaunch, while absent/stopped
panes require explicit open. A legacy single-repository recipe migrates to the first registered repo.

Main's MCP token scopes issue operations to its repository. It cannot submit issue-agent results;
issue-run identities cannot invoke Main tools. Main can approve only within the human's authorization,
and the same core guards apply. Tool definitions live in [mcp/lead.ts](../../packages/mcp/src/lead.ts).

`set_note` replaces repository notes (up to 2,000 characters; empty clears). Notes are included on
launch as context. `message_agent` targets an exact task/run or task/role with a short question or
heads-up, not a work assignment. Notes and idempotency receipts are durable; unavailable, waiting,
ended, ambiguous and foreign targets are refused. Queued is not delivered: native confirmation
uses the core message path. Main never waits or polls for an answer.

When the panel requests a summary, the coordinator sends it only if native status is idle without a
pending dialog. Chat visibility and starting/stopping Main are separate controls; see [UI](ui.md#main).
