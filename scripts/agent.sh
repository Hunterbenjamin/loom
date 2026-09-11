#!/usr/bin/env bash
# Start an agent on a brief: a worktree on <branch>, opened as a Herdr workspace, with an agent
# told to follow the brief. Run from a shell pane inside Herdr.
#
# Usage: scripts/agent.sh <name> <claude|codex> <branch> <brief> [extra `herdr worktree create` flags]
#   e.g. scripts/agent.sh core-design claude feat/core-design docs/briefs/phase-1a-core-design.md
# <brief> is relative to the repo root and must be committed: the worktree only has committed files.
# Add --trust-repository if Herdr asks for it.
set -euo pipefail

die() {
  printf 'agent.sh: %s\n' "$*" >&2
  exit 1
}

[ $# -ge 4 ] || die "usage: scripts/agent.sh <name> <claude|codex> <branch> <brief> [worktree flags]"
name="$1"
kind="$2"
branch="$3"
brief_path="$4"
shift 4

[ "${HERDR_ENV:-}" = 1 ] || die "run this from a shell pane inside Herdr"
command -v jq >/dev/null || die "jq is required"
case "$kind" in
  claude | codex) ;;
  *) die "agent kind must be claude or codex" ;;
esac
[[ "$name" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "name must match [a-z][a-z0-9_-]{0,31}"

repo="$(git rev-parse --show-toplevel)"
git -C "$repo" cat-file -e "HEAD:$brief_path" 2>/dev/null ||
  die "$brief_path is not committed on HEAD, so the new worktree won't have it"

created="$(herdr worktree create --cwd "$repo" --branch "$branch" --label "$name" --no-focus "$@")"
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

prompt="Read AGENTS.md and $brief_path, then carry out the work it describes within its rules. Stop and report once the pull request the brief asks for is open."
herdr agent prompt "$name" "$prompt" >/dev/null

# A successful `agent prompt` only means the text and Enter were written. A TUI that is still
# starting up can drop them (this happened to cold-started Codex and Claude agents), so confirm
# a turn began.
if ! herdr agent wait "$name" --until working --until blocked --timeout 30000 >/dev/null 2>&1; then
  printf '%s did not start working; its prompt was probably dropped.\n' "$name" >&2
  printf 'If its input box in pane %s is empty, resend with:\n  herdr agent prompt %s '\''%s'\''\n' "$pane" "$name" "$prompt" >&2
  exit 1
fi

printf 'started %s (%s) on %s in %s, pane %s\n' "$name" "$kind" "$branch" "$worktree" "$pane"
