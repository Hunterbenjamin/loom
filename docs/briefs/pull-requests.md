# Brief: pull requests in the app

Read `AGENTS.md`, `docs/architecture.md` (ownership table, "GitHub" under polling, the merge
rule), `docs/design/ui.md` (Tracker, Review) and `packages/adapters/github/README.md` first. This
brief is split into slices; each slice is one PR and says which earlier slices it needs.

## Why

Every review and merge today happens on github.com. The human should be able to see every pull
request of a registered repository, open it, read its description, checks and diff, squash-merge
it and delete its branch, without leaving Loom. This covers PRs Loom's tasks opened *and* PRs
opened by hand or by off-pipeline agents.

## Rules that shape it

- **GitHub owns PRs, branches, CI and merges** (principle 1). Loom caches what it read, with the
  read time, and re-reads after every action. No merge state is ever inferred locally.
- **Reconcile; don't copy events.** A merge from the app is an action against GitHub followed by
  a refresh. A task whose PR was merged this way reaches Done through the existing observation
  path, the same as a merge done on github.com. Nothing in the task workflow changes.
- **Every command is idempotent and confirmed by re-reading.** Merging an already-merged PR
  succeeds; deleting a branch that is gone succeeds.
- **Polling is conditional** (ETags through `gh api`, as the adapter already does), because
  webhooks can't reach localhost. List every 60 s while a window shows the PR view; the open PR's
  detail every 30 s while it is open; immediately after any command.
- **Always squash, always `--match-head-commit`,** as the adapter already enforces: a merge
  names the head SHA the human saw, and a push in between makes it fail with a clear reason.

## What the human sees

**Sidebar.** A new Tracker view, *Pull requests*, under the existing views, with the count of
open PRs for the selected repository.

**List.** One row per PR: number, title, head branch → base, author, age, and three badges: checks
(pass / pending / fail), review (approved / changes requested / none), and mergeability
(mergeable / conflicts / unknown). A PR whose head branch is a Loom task's branch shows the task
key, and clicking that opens the task. Filters: open (default), merged, closed; a text filter.
Sorted newest first. Keyboard as in the task list.

**Detail.** Opens in place of the task detail, same frame:

- header: title, number, state, head → base, author, "Open on GitHub";
- tabs: *Description* (the body as rendered markdown), *Checks* (every check run with status,
  duration and link), *Files* (the PR diff in the existing Pierre viewer, read-only, no findings),
  *Commits*;
- an action bar: **Squash and merge**, **Delete branch**, **Close**, **Refresh**.
  - *Squash and merge* is enabled when the PR is open, mergeable, and every check has passed. A
    confirmation names the head SHA and the base. When checks are pending or failed, the button
    stays visible but disabled with the reason; there is no override in v1.
  - The merge dialog has a checked-by-default *Delete branch after merge* box.
  - *Delete branch* alone is enabled on a merged or closed PR whose branch still exists.
  - *Close* asks for confirmation. Reopen is out of v1.
  - Every action shows its outcome inline (merged at, branch deleted, or the error from GitHub).

**Task detail.** The task's existing PR link opens the same PR detail inside the app instead of
the browser.

## Slices

1. **Adapter** (no prerequisites). In `packages/adapters/github`:
   `listPullRequests(repo, state)` (number, title, author, head, base, headSha, createdAt,
   updatedAt, draft, mergeable, checks summary, review summary, url); `readPullRequest(repo,
   number)` (the list fields plus body, mergedAt, mergeCommitSha, commits, check runs with
   names/status/conclusion/url, additions/deletions/changedFiles); `readPullRequestPatch(repo,
   number)` (the unified diff, through `gh api` with the diff media type; cap at 8 MiB and report
   truncation); `closePullRequest`; `deleteBranch(repo, branch)` (idempotent on 422 "reference
   does not exist"); and a `deleteBranch` option on `mergePullRequest`. Extend the interface in
   `packages/core/src/adapters.ts`, the fixtures, the fake GitHub in `packages/fake-agent`, and the
   contract tests. Real-provider test opt-in only.
2. **Protocol and coordinator** (needs 1). A `pullRequests` collection in the snapshot (the list
   fields plus `taskId` when the head branch matches a task's branch and repo); a
   `pull_request` subscription scope keyed by repo and number that carries the detail and the
   patch, like `diff` does for tasks; commands `merge_pull_request` (number, matchHeadSha,
   deleteBranch), `close_pull_request`, `delete_branch`, `refresh_pull_requests`, each answered
   with one ack and followed by a refresh; the polling schedule above, keyed on which windows
   subscribe. Commands go through the executor with the same precondition classification as
   `merge_pr`. Tests against the fake GitHub: list assembly, task linking, merge then refresh,
   a stale head SHA, a vanished branch.
3. **List view** (needs 2). The sidebar entry with count, the list with rows, badges, filters
   and keyboard navigation, fixture data for fixture mode, and the task-key link.
4. **Detail and actions** (needs 3). The detail frame, the four tabs (Files reuses the Pierre
   viewer in read-only mode), the action bar with its enablement rules and confirmations, inline
   outcomes, and the task detail's PR link opening in-app. Render tests for enablement and the
   confirmation flow; no real GitHub.
5. **Polish** (needs 4). Palette commands and shortcuts (`m` merge, `d` delete branch, `o` open on
   GitHub, `r` refresh), a system notification when a merge started from the app completes or
   fails, and a *Ready to merge* count in the bottom bar.

## Rules

- No durable state in the renderer (principle 5). Filters and the selected PR are per window.
- Never call GitHub from the renderer; every read and write goes through the coordinator.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` and the desktop build green. Update
  `docs/architecture.md` (ownership table, polling) and `docs/design/ui.md` where this changes
  them, in the same PR as the slice that changes them.
