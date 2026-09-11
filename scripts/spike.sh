#!/usr/bin/env bash
# Launch a spike: scripts/agent.sh with the spike's branch and brief. Run from a shell pane inside Herdr.
#
# Usage: scripts/spike.sh <spike-id> <claude|codex> [extra `herdr worktree create` flags]
#   e.g. scripts/spike.sh 05-restart-matrix claude
set -euo pipefail

if [ $# -lt 2 ]; then
  printf 'usage: scripts/spike.sh <spike-id> <claude|codex> [worktree flags]\n' >&2
  exit 1
fi
spike="$1"
kind="$2"
shift 2

exec "$(dirname "$0")/agent.sh" "spike-${spike%%-*}" "$kind" "spike/$spike" "spikes/$spike/BRIEF.md" "$@"
