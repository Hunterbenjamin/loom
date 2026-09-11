#!/usr/bin/env bash
# Launch a spike: a worktree on spike/<id>, opened as a Herdr workspace, with an agent that
# has been given its brief. Run from a shell pane inside Herdr.
#
# Usage: scripts/spike.sh <spike-id> <claude|codex> [extra `herdr worktree create` flags]
#   e.g. scripts/spike.sh 01-codex-shared-thread codex
#        scripts/spike.sh 01-codex-shared-thread codex --trust-repository
set -euo pipefail

die() {
  printf 'spike.sh: %s\n' "$*" >&2
  exit 1
}

[ $# -ge 2 ] || die "usage: scripts/spike.sh <spike-id> <claude|codex> [worktree flags]"
spike="$1"
kind="$2"
shift 2

[ "${HERDR_ENV:-}" = 1 ] || die "run this from a shell pane inside Herdr"
command -v jq >/dev/null || die "jq is required"
case "$kind" in
  claude | codex) ;;
  *) die "agent kind must be claude or codex" ;;
esac

repo="$(git rev-parse --show-toplevel)"
[ -f "$repo/spikes/$spike/BRIEF.md" ] || die "no brief at spikes/$spike/BRIEF.md"
name="spike-${spike%%-*}"

created="$(herdr worktree create --cwd "$repo" --branch "spike/$spike" --label "$name" --no-focus "$@")"
pane="$(jq -r '.result.root_pane.pane_id // empty' <<<"$created")"
worktree="$(jq -r '.result.worktree.path // empty' <<<"$created")"
[ -n "$pane" ] || die "could not read the new pane id from: $created"

# The new pane's shell may still be starting, so retry briefly. If the agent starts but stops
# at a prompt (usually "trust this folder?"), `agent start` fails yet the name resolves:
# wait for the human to answer it in Herdr instead of retrying.
started=0
for _ in 1 2 3 4 5; do
  if herdr agent start "$name" --kind "$kind" --pane "$pane" >/dev/null; then
    started=1
    break
  fi
  herdr agent get "$name" >/dev/null 2>&1 && break
  sleep 1
done
if [ "$started" = 0 ]; then
  herdr agent get "$name" >/dev/null 2>&1 || die "could not start $kind in pane $pane"
  printf '%s is waiting for input (probably a folder-trust prompt). Answer it in Herdr; continuing once it is idle.\n' "$name"
  herdr agent wait "$name" --until idle --until done --timeout 600000 >/dev/null
fi

brief="You are running Loom spike $spike. Read AGENTS.md, spikes/README.md and spikes/$spike/BRIEF.md, then carry out the spike within its rules and timebox. Stop and report once FINDINGS.md is committed, the branch is pushed and the draft PR is open."
herdr agent prompt "$name" "$brief" >/dev/null

# A successful `agent prompt` only means the text and Enter were written. A TUI that is still
# starting up can drop them (this happened to a cold-started Codex), so confirm a turn began.
if ! herdr agent wait "$name" --until working --until blocked --timeout 30000 >/dev/null 2>&1; then
  printf '%s did not start working; its prompt was probably dropped.\n' "$name" >&2
  printf 'If its input box in pane %s is empty, resend with:\n  herdr agent prompt %s '\''%s'\''\n' "$pane" "$name" "$brief" >&2
  exit 1
fi

printf 'started %s (%s) in %s, pane %s\n' "$name" "$kind" "$worktree" "$pane"
