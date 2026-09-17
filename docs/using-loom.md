# Using Loom on a project

Loom can work on multiple registered repositories. In the desktop repository selector, choose
**Add repository…** and select your local checkout. It needs a GitHub `origin` remote and GitHub
access that can push branches, open PRs, read checks and merge. Git owns branches and worktrees;
GitHub owns PRs, CI and merges. Loom coordinates the agents and observes those tools.

## What lives where

- **Loom's code** runs the desktop and coordinator. Its development instructions describe Loom,
  not the projects you register.
- **Instance data**, under `LOOM_DATA_ROOT/LOOM_INSTANCE`, holds the coordinator's database,
  artifacts and provider launch records. One instance can register several projects.
- **The target repository** holds your project's code, instructions and workflow commands.
- **Per-task worktrees** are isolated checkouts on task branches, created from the configured base
  branch. Agents implement there; the changes return to your project through PRs.

## Prepare the repository

Commit these three files at the repository root so they travel with its worktrees. Replace the
example commands and conventions with your project's own. Loom's own copies remain useful when
Loom itself is the target project.

`AGENTS.md` gives Codex the project's architecture, conventions and safety rules. For example:

```markdown
# Project instructions

Read docs/architecture.md before changing module boundaries.
Keep domain logic independent of database and network access.
Run the test files covering your change; record the command and result.
Never commit credentials or change production data.
```

`CLAUDE.md` gives Claude Code the same house rules. Keep a single source by importing them:

```markdown
@AGENTS.md
```

`WORKFLOW.md` gives Loom named commands. Each `##` heading immediately followed by a fenced block
is a command; `setup` runs in each new task worktree before the agent starts. For an npm project:

````markdown
## setup

```sh
npm ci
```

## test

```sh
npm test
```

## lint

```sh
npm run lint
```

## typecheck

```sh
npm run typecheck
```
````

Only include commands your project provides. Issue agents receive the commands through
`get_task_context`. Without `WORKFLOW.md`, Loom runs no setup step and has no known commands;
agents must inspect the repository to determine how to check their work. A malformed file also
exposes no commands. Loom reads this file from the registered repository root.

Cross-task project knowledge belongs in the repository's `AGENTS.md`, updated through PRs so it
is reviewable and available to future agents. Loom's task artifacts and Main's conversation notes
are not a substitute for project instructions.

## Choose repository settings

In Settings, select the repository scope. Set its **base branch** (the built-in default is `main`),
then choose role providers, models, reasoning effort, run mode and access. Workflow defaults cover
plan approval, issue size, time budget, review-round cap and merge policy. Workflow choices apply
to new tasks; role profiles apply to new runs. The Settings page shows each field's timing and
source. Repository overrides take precedence over global defaults, while environment overrides
and explicit task-creation values take precedence over them. Capacity, executable paths, timing,
Main and desktop preferences are instance-wide. See [settings architecture](architecture.md#settings)
for precedence and the authoritative catalog.

## Run an issue

Create an issue describing the outcome and constraints, then move it to Todo. Loom plans it,
requests plan approval when configured, implements in its worktree, pushes the submitted commit,
and observes GitHub checks before starting review. Configure CI to run on branch pushes: the PR
is opened after successful review. Without reported CI checks, review starts after a five-minute
grace from the successful push; that does not mean tests passed. Review and merge approval still
follow the issue's policy. Agents submit results; Loom's code moves issues between stages.
