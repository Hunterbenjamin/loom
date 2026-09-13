#!/usr/bin/env bash
# Dogfood smoke run: file one small task on the dev instance against the sandbox repo, wait for it
# to reach done (or fail), and append the result to docs/self-hosting-readiness.md. This is the
# only way Loom's own coordinator is exercised until the readiness checklist passes.
#
# Usage: scripts/smoke.sh [--timeout <minutes>] [--repo <repoId>] [--title <text>] [--note <text>]
#   e.g. scripts/smoke.sh
#        scripts/smoke.sh --timeout 15 --title "Add a line to README" --note "after #97"
# Needs the dev instance running (`pnpm loom serve`) with LOOM_INSTANCE, LOOM_DATA_ROOT and
# LOOM_TOKEN in the environment; `. ~/.loom/dev/env` sets them here.
set -euo pipefail

die() {
  printf 'smoke.sh: %s\n' "$*" >&2
  exit 1
}

timeout_min=10
repo="${LOOM_SMOKE_REPO:-Hunterbenjamin-loom-sandbox}"
title=""
note=""
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) [ $# -ge 2 ] || die "--timeout needs a value"; timeout_min="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; repo="$2"; shift 2 ;;
    --title) [ $# -ge 2 ] || die "--title needs a value"; title="$2"; shift 2 ;;
    --note) [ $# -ge 2 ] || die "--note needs a value"; note="$2"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac
done
[ "${LOOM_INSTANCE:-}" = dev ] || die "LOOM_INSTANCE must be dev (smoke runs never touch prod)"
[ -n "${LOOM_DATA_ROOT:-}" ] && [ -n "${LOOM_TOKEN:-}" ] || die "LOOM_DATA_ROOT and LOOM_TOKEN are required"

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
log="$root/docs/self-hosting-readiness.md"
loom() { (cd "$root" && pnpm --silent loom "$@"); }

stamp="$(date +%Y%m%d-%H%M%S)"
[ -n "$title" ] || title="Smoke $stamp: append a line to SMOKE.md"
description="Append the line \"smoke $stamp\" to SMOKE.md at the repository root, creating the file if it is missing. Change nothing else."

# The ack is JSON: {"kind":"task_created","taskId":"t-..."}.
ack="$(loom task create "$repo" "$title" "$description" --small)" || die "task create failed: $ack"
task="$(printf '%s' "$ack" | sed -n 's/.*"taskId": *"\([^"]*\)".*/\1/p')"
[ -n "$task" ] || die "no taskId in ack: $ack"
printf 'filed %s on %s\n' "$task" "$repo"

start="$(date +%s)"
deadline=$((start + timeout_min * 60))
result="timeout"
stage="?"
while [ "$(date +%s)" -lt "$deadline" ]; do
  show="$(loom task show "$task" 2>/dev/null || true)"
  stage="$(printf '%s\n' "$show" | sed -n 's/^  stage: //p')"
  attention="$(printf '%s\n' "$show" | sed -n 's/^  attention: //p')"
  failed="$(printf '%s\n' "$show" | sed -n 's/^  failed: //p')"
  case "$stage" in
    done) result="done"; break ;;
    canceled) result="canceled"; break ;;
  esac
  if [ -n "$failed" ] && [ "$failed" != "-" ]; then result="failed: $failed"; break; fi
  if [ -n "$attention" ] && [ "$attention" != "-" ]; then result="needs_you: $attention"; break; fi
  sleep 10
done
minutes="$(awk -v s="$start" -v e="$(date +%s)" 'BEGIN { printf "%.1f", (e - s) / 60 }')"

# A run that stops for a human is a failure of the bar, not something to answer here: cancel it so
# it holds no capacity, and record why. The pipeline's own timings tell the per-stage story.
case "$result" in
  done) ;;
  canceled) ;;
  *) loom task cancel "$task" "smoke: $result" >/dev/null 2>&1 || true ;;
esac
timings="$(loom task timings "$task" 2>/dev/null || true)"

printf '| %s | %s | %s | %s | %s |\n' "$(date +%Y-%m-%d)" "$task" "$result (stage $stage)" "$minutes" "$note" >> "$log"
printf '%s: %s after %s min (stage %s)\n' "$task" "$result" "$minutes" "$stage"
[ -n "$timings" ] && printf '%s\n' "$timings"
[ "$result" = done ]
