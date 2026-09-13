#!/usr/bin/env bash
# Start an agent on a brief: a git worktree on <branch>, a window on Loom's private tmux server,
# and an agent told to follow the brief. Run it from anywhere; it needs no terminal of its own.
#
# Usage: scripts/agent.sh <name> <claude|codex> <branch> <brief|-> [--task <text>] [--model <model>] [--base <branch>] [--auto|--full]
#   e.g. scripts/agent.sh core-design claude feat/core-design docs/briefs/phase-1a-core-design.md
#        scripts/agent.sh ui-shell claude feat/ui-shell docs/briefs/ui-shell.md --model opus
#        scripts/agent.sh fix-timings codex fix/timings - --task "loom task timings prints 0 for the last stage; fix it and add a test"
# <brief> is relative to the repo root and must be committed: the worktree only has committed files.
# Pass `-` and --task <text> instead for a job too small for a brief; the text is the whole job.
# Without --model the agent uses its own default. --auto reduces approval prompts: Codex runs
# --full-auto (writes sandboxed to the worktree; it asks only when a sandboxed command fails) and
# Claude runs --permission-mode acceptEdits. --full removes every prompt and sandbox (Codex
# --dangerously-bypass-approvals-and-sandbox, Claude --dangerously-skip-permissions): the agent
# can push, run gh and install packages unattended. Use one of them for Loom's own agents in
# isolated worktrees; --full is the one to use when nobody is watching the pane.
#
# It uses the same server as the coordinator's pane host, `-L loom-<instance>`, so there is one
# multiplexer. It never touches the default tmux socket or the user's own servers.
set -euo pipefail

die() {
  printf 'agent.sh: %s\n' "$*" >&2
  exit 1
}

[ $# -ge 4 ] || die "usage: scripts/agent.sh <name> <claude|codex> <branch> <brief|-> [--task <text>] [--model <model>] [--base <branch>] [--auto|--full]"
name="$1"
kind="$2"
branch="$3"
brief_path="$4"
shift 4

model=""
base="main"
auto=0
task=""
while [ $# -gt 0 ]; do
  case "$1" in
    --task) [ $# -ge 2 ] || die "--task needs a value"; task="$2"; shift 2 ;;
    --model) [ $# -ge 2 ] || die "--model needs a value"; model="$2"; shift 2 ;;
    --base) [ $# -ge 2 ] || die "--base needs a value"; base="$2"; shift 2 ;;
    --auto) auto=1; shift ;;
    --full) auto=2; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

case "$kind" in
  claude | codex) ;;
  *) die "agent kind must be claude or codex" ;;
esac
[[ "$name" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "name must match [a-z][a-z0-9_-]{0,31}"
command -v jq >/dev/null || die "jq is required"

tmux_bin="${LOOM_TMUX_BIN:-$(command -v tmux || true)}"
[ -x "$tmux_bin" ] || die "tmux is required (set LOOM_TMUX_BIN for a non-standard location)"
instance="${LOOM_INSTANCE:-dev}"
socket="loom-$instance"
session="loom-$name"
tm() { "$tmux_bin" -L "$socket" "$@"; }

repo="$(git rev-parse --show-toplevel)"
if [ "$brief_path" = - ]; then
  [ -n "$task" ] || die "a brief of - needs --task <text>"
else
  [ -z "$task" ] || die "give a brief or --task, not both"
  git -C "$repo" cat-file -e "HEAD:$brief_path" 2>/dev/null ||
    die "$brief_path is not committed on HEAD, so the new worktree won't have it"
fi

# Git owns worktrees and branches (principle 1); the pane host only opens a session on the path.
root="${LOOM_WORKTREE_ROOT:-$HOME/.loom/worktrees/$(basename "$repo")}"
worktree="$root/${branch//\//-}"
if [ ! -d "$worktree" ]; then
  mkdir -p "$root"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add "$worktree" "$branch" >/dev/null
  else
    git -C "$repo" worktree add -b "$branch" "$worktree" "$base" >/dev/null
  fi
fi
worktree="$(cd "$worktree" && pwd -P)"

# The private config, byte for byte what packages/adapters/tmux/src/config.ts writes. The server
# reads it only when it starts, so it is sourced again for a server that already exists.
conf="${LOOM_TMUX_CONF:-$HOME/.loom/$instance/tmux.conf}"
mkdir -p "$(dirname "$conf")"
cat > "$conf" <<'CONF'
set -g mouse on
set -g status off
set -g window-size latest
set -g aggressive-resize on
set -s extended-keys always
set -s extended-keys-format csi-u
set -as terminal-features ",xterm*:extkeys"
set -g remain-on-exit on
set -g update-environment ""
set -g destroy-unattached off
set -g history-limit 20000
set -g base-index 1
set -g @loom_event "init"
CONF

# tmux exits as soon as it has no sessions, so the first session is what creates the server — and
# what fixes its environment. Create it with an allowlist so nothing of this shell's leaks in.
if ! tm has-session -t "=loom-monitor" 2>/dev/null; then
  env -i \
    PATH="$PATH" HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
    SHELL="${SHELL:-/bin/sh}" TERM="${TERM:-xterm-256color}" TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-en_US.UTF-8}" \
    "$tmux_bin" -L "$socket" -f "$conf" \
    new-session -d -s loom-monitor -n monitor -- sleep 2147483647
fi
tm source-file "$conf"

tm has-session -t "=$session" 2>/dev/null ||
  tm new-session -d -s "$session" -n shell -c "$worktree"

if tm list-panes -t "=$session" -F '#{window_name}' | grep -qx agent; then
  die "$session already has an agent window; attach with: $tmux_bin -L $socket attach -t $session"
fi

cmd=("$kind")
case "$kind" in
  claude)
    [ -n "$model" ] && cmd+=(--model "$model")
    [ "$auto" = 1 ] && cmd+=(--permission-mode acceptEdits)
    [ "$auto" = 2 ] && cmd+=(--dangerously-skip-permissions)
    ;;
  codex)
    [ -n "$model" ] && cmd+=(-c "model=\"$model\"")
    [ "$auto" = 1 ] && cmd+=(--approve-for-me)
    [ "$auto" = 2 ] && cmd+=(--dangerously-bypass-approvals-and-sandbox)
    ;;
esac
# An escape hatch for testing this script's plumbing without starting a provider.
[ -n "${LOOM_AGENT_EXEC:-}" ] && cmd=("$LOOM_AGENT_EXEC")

before="$(date +%s)"
pane="$(tm new-window -d -P -F '#{pane_id}' -t "$session:" -n agent -c "$worktree" -- "${cmd[@]}")"
# Leave the session on the agent window, so a plain `attach` (a Herdr pane, a Ghostty tab) shows the
# agent rather than the idle shell window created first. Grouped views keep their own selection.
tm select-window -t "$session:agent"

if [ -n "$task" ]; then
  prompt="Read AGENTS.md, then do this within its rules: $task. Work on branch $branch, run pnpm test, pnpm lint and pnpm typecheck, and open a pull request against $base. Stop and report once it is open."
else
  prompt="Read AGENTS.md and $brief_path, then carry out the work it describes within its rules. Stop and report once the pull request the brief asks for is open."
fi

# Wait for the TUI to be ready for input before pasting: a cold-started Codex or Claude drops a
# prompt typed too early. The pane being alive is the only thing the host can tell us; the
# provider's own channel confirms the prompt below.
sleep 5
buffer="loom-agent-$$"
tm set-buffer -b "$buffer" -- "$prompt"
tm paste-buffer -p -d -b "$buffer" -t "$pane"
sleep 0.2
tm send-keys -t "$pane" Enter

# A paste is only "bytes written". Confirm from the provider that a turn actually began; both
# checks read the provider's own store, never the terminal.
confirmed=0
for _ in $(seq 1 60); do
  case "$kind" in
    claude)
      if claude agents --json 2>/dev/null |
        jq -e --arg cwd "$worktree" 'any(.[]; .cwd == $cwd and .status == "busy")' >/dev/null; then
        confirmed=1
      fi
      ;;
    codex)
      # Codex has no status command, but its state database records every thread with its cwd,
      # creation time and first user message. A thread for this worktree, created after launch,
      # whose first message is our prompt, is provider-owned proof the prompt landed. (The rollout
      # transcript used before was not written for a fresh thread; this table was.)
      db="$(ls -t "${CODEX_HOME:-$HOME/.codex}"/state_*.sqlite 2>/dev/null | head -n 1)"
      if [ -n "$db" ] && command -v sqlite3 >/dev/null; then
        q_wt="${worktree//\'/\'\'}"; q_prompt="${prompt//\'/\'\'}"
        n="$(sqlite3 -readonly "$db" "select count(*) from threads where cwd = '$q_wt' and created_at >= $before and first_user_message = '$q_prompt';" 2>/dev/null || echo 0)"
        [ "${n:-0}" -gt 0 ] && confirmed=1
      fi
      ;;
  esac
  [ "$confirmed" = 1 ] && break
  sleep 1
done

attach="$tmux_bin -L $socket attach -t $session"
if [ "$confirmed" = 0 ]; then
  printf '%s did not start working; its prompt was probably dropped.\n' "$name" >&2
  printf 'Check pane %s, and resend by hand if its input box is empty:\n  %s\n' "$pane" "$attach" >&2
  exit 1
fi

printf 'started %s (%s%s) on %s in %s\n' "$name" "$kind" "${model:+, $model}" "$branch" "$worktree"
printf 'attach:  %s\n' "$attach"
