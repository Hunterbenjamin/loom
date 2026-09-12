# Phase 2: `packages/adapters/git`

**Agent:** codex · **Branch:** `feat/adapter-git` · **PR title:** "Phase 2: git adapter". Read
[`phase-2-common.md`](phase-2-common.md) first.

## Build

Implement `GitAdapter` from `packages/core/src/adapters.ts` over the `git` CLI (spawn it; no
libgit2 binding).

- `realpath`: canonical path, so `/var/…` and `/private/var/…` compare equal (principle 6).
- `readWorktree`: `GitWorktreeObservation`, including the fields the design made required:
  `dirtyPaths` (tracked changes plus non-ignored untracked paths; `.task/` and ignored build output
  never count) and `reachableCommits` for the SHAs the caller asks about. `conflictsWithBase` comes
  from `git merge-tree --write-tree` against the base branch; `remoteHeadSha` from the last fetch,
  never a live network call.
- `createWorktree`: idempotent. An existing worktree on that branch is returned, not recreated.
- `push`: refuses unless the local head equals `expectedHeadSha`; never `--force`.
- `writeTaskFiles`: writes `<worktree>/.task/` and keeps `.task/` in `.git/info/exclude`.
- `changedFiles`: from NUL-delimited metadata (`git diff --raw -z`, `--find-renames`), never from
  patch text, with hunk ranges from `git diff -U0`. Quoted or unicode paths must come out right
  (spike 04 found `core.quotePath` matters).
- `readBlob`: null for binary.

## Tests

Unit tests build throwaway repos under the OS temp directory, so they run for real without touching
anything of the user's. Cover: realpath equivalence, dirty versus ignored paths, rename detection, a
unicode filename, the push refusal, idempotent worktree creation, and `merge-tree` conflict detection.

## Out of scope

GitHub, ports, and anything that reads a PR.
