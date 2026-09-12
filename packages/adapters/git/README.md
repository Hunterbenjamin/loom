# Git adapter

`createGitAdapter({ remote?: string })` implements core's `GitAdapter` with spawned
Git commands. The remote defaults to `origin`. Tested with Git 2.51.2 and SHA-1
repositories (core's `Sha` contract is 40 hex characters). Older Git versions have
not been validated; `merge-tree --write-tree` and `GIT_NO_LAZY_FETCH` are required.

`readWorktree(path, baseBranch, reachableCandidates?)` checks each requested commit
against the captured HEAD. Callers must supply every pending fixing commit before
running the corresponding core guard. Missing objects, bad bases, failed metadata
reads and a moving HEAD reject the read; the coordinator should turn that rejection
into a failed `Reading`. Missing directories return `exists: false`; unborn HEADs
have null SHA/conflict fields. Paths must name a worktree root.

Reads do not fetch. `remoteHeadSha` reads `refs/remotes/<remote>/<branch>` from local
Git state, which fetch or push can update; a missing tracking ref is null. Lazy
fetching is disabled so partial-clone reads fail on unavailable objects instead of
silently going to the network. Push checks the checked-out branch and its SHA,
then pushes that immutable SHA with an explicit non-forcing refspec. It does not
push additional tags or submodules. Git hooks retain their normal behavior.

`writeTaskFiles` accepts plain filenames (no directories or traversal), atomically
replaces each file and rejects a symlinked `.task` directory. It preserves the
existing exclude file and adds `/.task/` once. Git's `--git-path info/exclude`
resolves to the common Git directory for linked worktrees; `<worktree>/.git` is a
file there. Task files are filtered out of dirty paths even if already tracked.

Diff paths, statuses, object IDs and binary flags come from NUL-delimited raw and
numstat metadata. Hunks come from `git diff -U0` between each pair of blobs, so
quoted patch headers never identify files. Git attributes determine the binary
flag; external diff drivers and textconv are disabled. Gitlinks have null blob IDs
and no text hunks. `readBlob` has no path/attributes context: it returns null for
NUL bytes in the first 8,000 bytes or invalid UTF-8, and otherwise returns UTF-8
text. Added/deleted text diffs may write the empty blob into Git's object store.

What the real tool actually does:

- `merge-tree --write-tree` returns 1 for conflicts and 0 for a clean merge. Both
  produce a result tree; operational failures are errors. It writes Git objects
  but leaves HEAD, the index and working files untouched.
- `show-ref --verify --hash` exits 128 for an absent ref. The adapter uses
  `show-ref --verify --quiet` (exit 1 for absence), then resolves the existing ref.
- Porcelain `-z` rename status lists destination before source, while raw diff
  `-z` lists source before destination. Paths can contain quotes and newlines.
- A valid empty diff is zero metadata records. Binary changes may have no hunks;
  empty text files also have no hunks and remain distinguishable by metadata.

Git invocations have a 60-second timeout and a 64 MiB stdout limit. Failures omit
arguments and stderr to avoid exposing credentials embedded in remote URLs.
Inherited Git routing/configuration environment variables are scrubbed; repository
and normal Git configuration still apply. No shared daemon or global config is
modified.

Tests create and remove their own OS-temporary repositories and local bare remotes.
They run real Git without agents or external network services; recorded fixtures
also cover parser rejection. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` at
the repository root. There are no opt-in real-agent/provider tests in this package.
