# Brief: Reviews, shaped like Linear

Read `AGENTS.md`, `docs/briefs/pull-requests.md` (what exists: the GitHub adapter, the
`pullRequests` collection, the `pull_request` detail scope, the merge/close/delete commands, the
current list and detail views) and `docs/design/ui.md` first. Three reference screenshots are at
`/Users/hlbenjamin/.loom/dev/reference/linear-reviews-1.png` (the Reviews list),
`linear-reviews-2.png` (a pull request's Overview) and `linear-reviews-3.png` (its Diff). Open
them; they are the spec for layout and behaviour. Where the text below and the screenshots
disagree on looks, the screenshots win. Each slice is one PR; slices say what they need.

## Why

The current pull-request view loads slowly and reads as a table of fields. The human wants the
experience Linear gives: a Reviews inbox grouped by what needs them, a pull request page whose
primary action is Squash & merge, and a Diff tab with per-file cards they can tick off. GitHub
stays the owner of every fact; Loom stays a fast, honest view of it.

## Slices

1. **Load fast, show early** (no prerequisites). Measured today: the open list arrives in about a
   second; one PR's detail takes 14 seconds, because the coordinator reads the PR, then its patch,
   then the PR again to check consistency, serially, and publishes nothing until all three return.
   Change: the detail is one GraphQL request (title, body, author, base, head, headRefOid,
   mergeable, reviewDecision, commits with messages and authors, check runs with name, status,
   conclusion and url, files with path, additions, deletions and changeType, reviews, comments)
   and the patch is one REST diff request, run in parallel; consistency is checked by comparing
   the head SHA in both responses, not by a third read. Publish the detail as soon as it arrives
   and the patch in a second patch; the view renders the overview immediately and the Diff tab
   shows a loading state until the patch lands. Cache by head SHA: an unchanged head re-reads
   nothing but the check runs. Target: overview visible in under two seconds, diff under four,
   on this repository. Add timing to the coordinator log for each read.

2. **The Reviews list** (needs 1). A `Reviews` entry in the Tracker sidebar with the count of
   PRs that need the human, replacing the current Pull requests entry. Tabs at the top: *For you*
   (PRs that need the human: ready to merge, changes requested of them, review requested) and
   *Created* (PRs whose author is the human). Grouped sections in this order, each a collapsible
   header with a count: *Ready to merge* (open, mergeable, checks passed, review converged),
   *Needs attention* (open with failing checks, conflicts, or changes requested), *Waiting* (open,
   checks pending or review in progress), *Created by you*, and *Completed N* collapsed by
   default (merged and closed, newest first, load more in pages of 20). A row is: the PR glyph
   (green open, purple merged, red closed), the title, a single trailing status glyph (green check
   for all passed, red cross for failed, an amber dot for pending, a lightning bolt when a Loom
   agent is currently working on that branch) and the age. Rows for a task branch open the issue's
   key on hover. Keyboard as in the issue list; Enter opens the PR.

3. **The pull request page: Overview** (needs 1). Header row: breadcrumb `<linked issue key or
   "No issue"> › <title>`, then `+adds −dels`, a star to pin, an overflow menu, a `loom#N` chip
   linking to GitHub, and a fullscreen toggle. Below it a segmented control *Overview | Diff* on
   the left and on the right the primary button **Squash & merge** (with a split menu for merge
   options: delete branch after merge on by default; disabled with the reason when not mergeable
   or checks not passed) and a run-agent button that opens the branch's Loom agent if one exists.
   Body, left column: the title as a heading, then `author · main ← branch`, *Description* as
   rendered markdown, *Activity* (opened by, commits, reviews, merges, in order, with ages) and a
   comment box that posts a PR comment. Right rail, in this order: *Status* (Open / Merged /
   Closed with glyph), *Resolves* (the linked Loom issue, or *Link issue* which links a task by
   key), *Reviewers* (from GitHub; *Add reviewers* is out of v1, show it disabled), *Checks* (one
   line summary, expandable to the check runs), *Branch* (Up to date / Behind main by N / Conflicts),
   and *N files changed* grouped into *Implementation* and *Tests* (a test file is one whose path
   matches `*.test.*` or lives under a `test`/`tests`/`__tests__` directory) with per-group and
   per-file `+adds −dels`; clicking a file opens the Diff tab scrolled to that file.

4. **The pull request page: Diff** (needs 3). A bar with *Files N* and *Commits N* toggles and a
   settings button (split/unified, whitespace). Under *Files*: one card per file, in the order of
   the right rail, with the file name and directory, `+adds −dels`, a *Reviewed* checkbox and an
   overflow menu; the diff rendered by the existing Pierre viewer in unified mode with syntax
   colours, line numbers, and collapsible unchanged regions shown as "N unchanged lines" rows with
   expand arrows above and below each hunk; a card collapses to its header when marked Reviewed.
   Reviewed state is coordinator-owned per PR and head SHA through the existing review-state
   commands (viewed files), so it survives a window closing and resets when the head changes.
   Under *Commits*: the commits with message, author and age; clicking one shows only that
   commit's diff. Keyboard: `j`/`k` next and previous file, `v` toggles Reviewed, `[`/`]` previous
   and next hunk.

5. **Polish** (needs 4). Cmd+Enter merges from anywhere on the page with the confirmation.
   Linking an issue writes the link both ways (the issue shows its PR). A merged PR whose branch
   is a Loom task branch triggers the task's observation so it reaches Done without waiting for
   the poll. Fixture data for fixture mode covers every section.

## Rules

- GitHub owns PRs, branches, checks and merges; every action is a call followed by a re-read.
  No merge state is inferred locally. Merges stay squash with a head SHA match.
- No durable state in the renderer; Reviewed marks and the pinned star live with the coordinator.
- Never call GitHub from the renderer.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` and the desktop build green; update
  `docs/design/ui.md` and `docs/briefs/pull-requests.md` where this supersedes them.
