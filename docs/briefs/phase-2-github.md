# Phase 2: `packages/adapters/github`

**Agent:** codex · **Branch:** `feat/adapter-github` · **PR title:** "Phase 2: GitHub adapter". Read
[`phase-2-common.md`](phase-2-common.md) first.

## Build

Implement `GitHubAdapter` from `packages/core/src/adapters.ts` over the `gh` CLI (`gh api` and
`gh pr`), using the user's existing authentication.

- `findPullRequest`: the PR whose head is the branch, open or not, as a `PullRequestObservation`.
  Conditional requests with the ETag the caller passes back. It must include: `mergeable` as
  `mergeable | conflicting | unknown` (GitHub computes this lazily; `unknown` is a real state, never
  guess), `autoMergeEnabled`, CI as a `CiState` whose every `CiCheck` carries its stable check-run
  `id` (required by the design; never synthesize one), reviews, and human comments excluding ones
  Loom or its agents wrote.
- `openPullRequest`: idempotent; an existing PR for the branch is returned.
- `mergePullRequest`: always squash, always `--match-head-commit`, `--auto` when asked. Map a head
  mismatch or not-mergeable refusal to a `precondition` error, rate limiting to `retryable`.
- `disableAutoMerge`: succeeds when it's already off.

## Tests

Unit tests run against recorded `gh` output (fixtures) with the CLI stubbed, covering: ETag
not-modified, the three mergeability states, a PR with failing checks, comments filtered by author,
merge precondition failure, and rate-limit mapping. An opt-in real test may read a public PR
(`vuejs/core` is fine) but never writes to any repository.

## Out of scope

Webhooks, GitHub Apps, and issue import.
