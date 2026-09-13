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
- **Polling uses one GraphQL request per list** through `gh api graphql`, including checks,
  review decision and mergeability (100 rows per page; cursor pagination up to the existing
  1,000-page cap). GraphQL has no ETag: compare mapped rows per repo/state and publish no patch
  when unchanged. Reviews slice 1 supersedes the detail transport: one GraphQL content read and an immutable
  REST compare diff, published independently. Warm polls refresh metadata/checks and reuse content
  and diff by head/base; an edited PR or explicit refresh invalidates content. List every 60 s while
  a window shows the PR view; detail every 30 s while it is open; refresh after any command.
  First snapshots and subscription acknowledgments use the cached projection immediately,
  with `loading: true` for an initial list read; rows arrive in patches. Different scopes read
  concurrently and identical scopes share at most one in-flight read.
- **Always squash, always `--match-head-commit`,** as the adapter already enforces: a merge
  names the head SHA the human saw, and a push in between makes it fail with a clear reason.

## What the human sees

**Sidebar and list.** Superseded by Reviews slice 2 in `docs/briefs/reviews.md`: the
sidebar entry is **Reviews**, with the count needing the human. **For you** and **Created**
replace the state tabs. Collapsible Ready to merge, Needs attention, Waiting, Created by you
and Completed sections replace the field table. Completed starts collapsed and reveals the
newest merged/closed PRs in pages of 20. Rows show a state glyph, title, one check/working
glyph and age; the linked issue key appears on hover or keyboard focus. Existing detail and
actions below remain unchanged.

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

## Superseded by Reviews slice 1

`docs/briefs/reviews.md` slice 1 changes loading only; the current sidebar, tabs and actions stay.
GraphQL detail includes file metadata, reviews and comments for future slices. Detail publishes
before its diff. The Files tab shows Loading diff until the matching patch arrives, or a retryable
error while Description remains readable. List rows now include `baseSha`; diff payloads carry
both requested SHAs and may be null while loading. GitHub diff responses contain no commit SHA,
so the REST diff uses an immutable base/head compare endpoint. Cached list SHAs allow parallel
reads; a direct open without cached metadata fetches detail before the diff. An outdated list
range is never attached to a new head. Coordinator logs record read durations.

## Superseded by Reviews slice 2

List and detail summaries carry GitHub's `viewerDidAuthor`, `viewerReviewRequested`,
`reviewRequired` and `completedAt` (GitHub `closedAt`). No identity is inferred from local
Git configuration or a task link. Required/pending review prevents the Reviews ready group;
existing merge action guards and bottom-bar semantics are unchanged. The Reviews sidebar
count includes ready PRs, viewer review requests, and the viewer's PRs with failing checks,
conflicts or requested changes. Reviews subscribes to open, merged and closed lists while
visible; history uses the existing shared list reads, with 20-row presentation pages.

## Superseded by Reviews slice 3

`docs/briefs/reviews.md` slice 3 replaces the four-tab detail and action bar with the referenced
Overview / Diff page. Description, activity/commits and expandable checks now live in the
Overview's reading column and property rail. The header provides a durable pinned star, overflow
Close/Delete branch/Refresh actions, GitHub chip and fullscreen. Squash & merge retains all
existing guards and its exact-head confirmation, with a split menu for the default-on branch
deletion option. The agent button opens an existing branch agent; it does not launch one.

The rail adds same-repository issue linking, GitHub reviewers, branch divergence and grouped
file counts; file selection opens the existing Diff viewer at that path. Pin and link commands
persist in the coordinator, while PR comments go through the executor/adapter and owner refresh.
The Reviews inbox and reviews slice 5 polish remain separate; Diff is superseded below.

## Superseded by Reviews slice 4

The Diff tab now uses the referenced Files/Commits bar and per-file Pierre cards, ordered like
the Overview rail. Unified/split and whitespace settings, expandable unchanged regions, file/hunk
keyboard navigation, and on-demand first-parent commit diffs replace the old sidebar viewer.
Reviewed files are coordinator-owned, scoped to repository, PR number and head SHA, using the
existing `save_review_state` viewed-file contract with a PR target. Marking a file collapses it;
new heads reset the visible marks. Commit-only views cannot mark the entire PR reviewed.
Reviews slice 5 remains separate.
