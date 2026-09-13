# GitHub adapter

`createGitHubAdapter({ excludedAuthors })` implements core's `GitHubAdapter` through
`gh api` and `gh pr`. It uses the user's existing `gh` authentication on github.com;
no token extraction, global configuration changes, or direct HTTP client. Requires
Node 22+ and `gh` (verified with 2.90.0).

```ts
import { createGitHubAdapter } from "@loom/adapter-github";

const github = createGitHubAdapter({
  excludedAuthors: ["loom-bot", "agent-account"],
});
const reading = await github.findPullRequest({
  repo: "owner/repository",
  branch: "feat/example",
  etag: null,
});
```

The caller must explicitly supply every account used by Loom or its agents. GitHub
cannot distinguish an agent from a human using the same account; excluding a shared
account also excludes that human's comments. Accounts with `type: Bot` and comments
with deleted/unknown authors are excluded automatically. There is no body-marker
heuristic. `run` and `now` are injectable for tests.

## Reads

- `repo` is `owner/name`. A plain branch belongs to that owner; `head-owner:branch`
  explicitly selects a fork. Search covers all PR states, preferring an open PR and
  otherwise the newest closed/merged PR when a branch name has been reused.
- Reads PR detail, all check-run pages, combined commit status, all reviews, and all
  issue/review comment pages. A final PR read rejects a head/base change during the
  read as `retryable`. GitHub does not offer an atomic snapshot across these resources.
- `mergeable: null` remains `unknown`. A REST `merge_commit_sha` on an unmerged PR
  describes a test merge; it is exposed as `mergeCommitSha` only after a real merge.
- Check IDs are GitHub's stringified numeric check-run IDs, never inferred from names.
  Waiting/requested/pending check runs normalize to `queued`; incomplete checks stay
  pending. Completed neutral/skipped checks count as successful. Other completed
  non-null conclusions fail conservatively. Legacy statuses contribute to the aggregate
  CI conclusion but are not misrepresented as check runs with fabricated IDs.
- Nonempty human review summaries also become comments, linked to their review so
  a changes-requested review without inline comments can become a blocking finding.
  These use GitHub's native review node ID; regular comments use their numeric IDs.
  Outdated inline comments preserve `line: null`, their side, and their commit anchor.

## Repository pull requests (slice 1)

- `listPullRequests(repo, state)` accepts `open`, `merged`, or `closed` (closed excludes
  merged), follows every list page, hydrates checks/reviews/mergeability, and returns
  newest-first `PullRequestSummary` values, including `observedAt`.
- `readPullRequest(repo, number)` adds the body, merge facts, commits, native check runs
  with start/completion times, and change counts. Detail also includes `branchExists`, read
  from the actual head repository; an unidentified repository remains null (unknown). Null authors remain null; a null body
  becomes an empty string. Latest decisive review per author wins; comments/pending
  reviews do not erase a decision, and any outstanding changes request takes priority.
  Check summaries include legacy commit statuses using the same rules as task observations.
- Each endpoint/page is conditionally refreshed using native ETags, even when the PR
  itself is unchanged. These methods return the full value on each successful read and
  retain only disposable per-list/per-detail caches (128 keys). A changed head/base or
  update timestamp during assembly is retryable. GitHub's PR commits endpoint is capped
  at 250; a count mismatch is an explicit incomplete-read error, never silent omission.
- `readPullRequestPatch(repo, number)` requests `application/vnd.github.diff` through
  `gh api`. It returns `{ patch, truncated, observedAt }`, capped at 8 MiB of UTF-8 without
  cutting a code point. Subprocess capture is bounded, including a 64 KiB header allowance;
  larger responses are drained without retaining them. Empty/non-diff responses fail.
  The separate ETag cache holds at most four patches (32 MiB).
- `closePullRequest(repo, number)` re-reads after closing and succeeds on an already
  closed or merged PR. Lost command responses are recovered only through owner readback.
- `deleteBranch(repo, branch)` deletes only the named **remote** head through REST,
  then verifies its absence. HTTP 422 with exactly `Reference does not exist` is
  idempotent; other 422 errors are not swallowed. No local branch/worktree is touched.
- `mergePullRequest({ ..., deleteBranch: true })` deletes the actual head repository's
  branch only after confirming the merge. Forks never fall back to the base repository.
  A retry on an already-merged PR completes unfinished deletion. With `auto: true`,
  deletion is deferred until a later call observes the merge; this adapter has no durable
  deferred-action queue. A caller wanting immediate merge-and-delete uses `auto: false`.

Only adapter contracts and fakes are added here. Coordinator polling schedules, protocol
commands, and UI are later slices. Repository reads use the same ownership and conditional
polling rules below; they do not create tasks or change workflow stages.

## Conditional polling

Pass the returned `etag` back unchanged. It is an opaque validator for the combined
observation, excluding the poll timestamp. Internally the adapter retains the native
ETag and validated body for each endpoint/page and sends `If-None-Match` to each
resource. A PR-only 304 never skips CI, reviews, or comments. A full last page is
refreshed unconditionally: an appended next page can change the Link header without
changing that last page's body/ETag.

The cache is disposable, bounded to 128 repo/branch observations, and updated only
after a successful complete read. Restart, eviction, or an unfamiliar validator
causes full reads. Callers retain their previous value on `notModified: true` and
record their own successful-read time. No durable state lives in this adapter.

## Actions and errors

Opening a PR first looks for an existing PR in any state, sends a multiline body via
stdin to `gh pr create --body-file -`, then re-reads identity from JSON. The readback
also handles concurrent creation or a lost creation response.

Merging checks the approved head, always invokes `gh pr merge --squash
--match-head-commit <sha>`, adds `--auto` when requested, and re-reads the result.
Already merged or already enabled squash auto-merge is idempotent. Success is never
inferred from human-readable CLI stdout. Disabling auto-merge checks before and after
and succeeds if a concurrent caller already disabled it. No admin override, force push, merge-stage transition, or automatic retry is performed here.

`GitHubError` exposes `code: precondition | retryable | fatal` and a sanitized message
suitable for an executor's `ActionError`. CLI diagnostics classify refusals and rate
limits but never supply observation facts. Timeout/transport failure is retryable;
auth/permission failures and invalid JSON/schema are fatal. Each subprocess has a
60-second deadline and a 16 MiB combined output limit. A timeout has an uncertain write
outcome; the coordinator must reconcile before retrying.

The core contract cannot express merge-queue enrollment. If `gh` queues a merge but
neither a merge nor squash auto-merge is observable, this adapter returns retryable
instead of claiming it merged. Enterprise hosts are outside this package's current scope.

## Verification and observed CLI behavior

Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` from the repository root. Unit tests
stub `gh` against [recorded fixtures](src/fixtures/README.md), plus explicitly derived
failure/race/pagination cases. The opt-in test only reads a public PR:

```sh
LOOM_REAL_PROVIDERS=1 pnpm exec vitest run packages/adapters/github/src/real.test.ts
```

Observed with `gh` 2.90.0 on 2026-09-12: `gh api --include` returns **exit code 1** for
HTTP 304, with status and headers still on stdout. The adapter recognizes the HTTP
status before classifying CLI failure. The recorded merged Vue PR has null
mergeability, reinforcing that unknown is valid even on a merged PR. Real mutation
tests are intentionally absent; all action tests use the stub.

References: [GitHub conditional requests and pagination](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api),
[PR mergeability and test merge commits](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database),
[`gh pr merge` guards and merge queues](https://cli.github.com/manual/gh_pr_merge).
