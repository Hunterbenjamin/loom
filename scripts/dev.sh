#!/usr/bin/env bash
# The dev launcher: the coordinator and the desktop app for one instance, each in its own window
# on that instance's private tmux server, so they outlive any terminal and can be restarted
# independently. Nothing here touches the default tmux socket or another instance.
#
# Usage: scripts/dev.sh up|sync|down|restart|status|logs|install-launcher [coordinator|app]
#   scripts/dev.sh up                 start both (a running one is left alone)
#   scripts/dev.sh sync               the one safe button: pull the latest main when that is safe,
#                                     start what is down, restart what is stale, leave the rest
#                                     alone (coordinator first)
#   scripts/dev.sh restart            stop and start both, coordinator first
#   scripts/dev.sh restart app        just the desktop app (after a main-process change)
#   scripts/dev.sh restart coordinator
#   scripts/dev.sh down               stop both
#   scripts/dev.sh status             what is running, whether it is stale, ports, app-servers
#   scripts/dev.sh logs [coordinator|app]   tail the log
#   scripts/dev.sh install-launcher   build "Loom Dev.app" in ~/Applications for the Dock
#
# Staleness: each start records a fingerprint of the files that process was built from (see
# coordinator_paths / app_paths). `status` compares it with the working tree, and `sync` restarts
# only what differs. The renderer hot-reloads local edits, so it is not part of the app's
# fingerprint; renderer changes arriving in new commits still restart the app.
#
# Updating: only explicit `sync` fetches origin and fast-forwards the checkout when it is
# on the base branch (LOOM_BASE_BRANCH, default main) with no uncommitted tracked changes. On any
# other branch, or with local changes, the checkout is left alone and the missing commits are
# reported. A changed lockfile runs `pnpm install --frozen-lockfile`. LOOM_NO_UPDATE=1 skips it.
#
# Environment comes from $LOOM_DATA_ROOT/$LOOM_INSTANCE/env (default ~/.loom/dev/env), which must
# export LOOM_INSTANCE, LOOM_DATA_ROOT and LOOM_TOKEN at least.
set -euo pipefail

instance="${LOOM_INSTANCE:-dev}"
root="${LOOM_DATA_ROOT:-$HOME/.loom}"
env_file="$root/$instance/env"
die() { printf 'dev.sh: %s\n' "$*" >&2; exit 1; }
[[ "$instance" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || die "LOOM_INSTANCE must be a plain name"
[ -f "$env_file" ] || die "no environment file at $env_file"
set -a
. "$env_file"
set +a
[ "${LOOM_INSTANCE:-$instance}" = "$instance" ] || die "LOOM_INSTANCE in $env_file disagrees with selected instance"
[ "${LOOM_DATA_ROOT:-$root}" = "$root" ] || die "LOOM_DATA_ROOT in $env_file disagrees with selected data root"
export LOOM_INSTANCE="$instance" LOOM_DATA_ROOT="$root"
export LOOM_BIND="${LOOM_BIND:-127.0.0.1:47800}"
bind_port="${LOOM_BIND##*:}"
[[ "$bind_port" =~ ^[0-9]+$ ]] || die "LOOM_BIND must be host:port"
export LOOM_MCP_PORT="${LOOM_MCP_PORT:-$((10#$bind_port + 1))}"
export LOOM_HOOK_PORT="${LOOM_HOOK_PORT:-$((10#$bind_port + 2))}"
export LOOM_RENDERER_PORT="${LOOM_RENDERER_PORT:-5173}"
for key in LOOM_MCP_PORT LOOM_HOOK_PORT LOOM_RENDERER_PORT; do
  value="${!key}"
  [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || die "$key must be a port from 1 to 65535"
done
socket="loom-$instance"
launcher_name="Loom $instance"
[ "$instance" != dev ] || launcher_name="Loom Dev"
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
serve_log="$root/$instance/serve.log"
app_log="$root/$instance/desktop-dev.log"
started_dir="$root/$instance/started"
# A launcher started from Finder or launchd has a bare PATH and no .zshrc, so the places pnpm and
# Homebrew normally live are added here, and the resulting PATH is handed to every pane explicitly.
for dir in "${PNPM_HOME:-$HOME/Library/pnpm}" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$dir:$PATH" ;; esac
done
# The providers usually come from .zshrc (claude in ~/.local/bin, codex under nvm), which such a
# launcher never reads, so append whatever the human's own interactive shell adds. The marker keeps
# anything an rc file prints out of PATH. Without this the coordinator could not start any agent.
shell_path="$("${SHELL:-/bin/zsh}" -ilc 'printf "\n__loom_path__%s\n" "$PATH"' 2>/dev/null </dev/null |
  sed -n 's/^__loom_path__//p' | tail -1 || true)"
IFS=: read -ra shell_dirs <<<"$shell_path"
# The ${a[@]+...} form keeps bash 3.2 (macOS /bin/bash) from failing on an empty array under set -u.
for dir in "$HOME/.local/bin" ${shell_dirs[@]+"${shell_dirs[@]}"}; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -n "$dir" ] && [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
export PATH
tmux_bin="${LOOM_TMUX_BIN:-$(command -v tmux || true)}"

[ -x "$tmux_bin" ] || die "tmux is required"
command -v pnpm >/dev/null || die "pnpm is not on PATH (looked in \$PNPM_HOME, ~/Library/pnpm, /opt/homebrew/bin)"
for provider in claude codex; do
  command -v "$provider" >/dev/null ||
    printf 'dev.sh: warning: %s is not on PATH; the coordinator cannot start %s runs\n' "$provider" "$provider" >&2
done
tm() { "$tmux_bin" -L "$socket" "$@"; }

# What each process is built from. Anything the coordinator or Electron's main process loads;
# the renderer (apps/desktop/src/renderer) hot-reloads and is deliberately absent.
coordinator_paths=(apps/coordinator packages package.json pnpm-lock.yaml pnpm-workspace.yaml)
app_paths=(apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared
  apps/desktop/electron.vite.config.ts apps/desktop/scripts/dev-ports.ts
  apps/desktop/package.json packages pnpm-lock.yaml)

fingerprint() {  # content hash of the given paths as they are in the working tree, plus the env
  {
    git -C "$repo" ls-files -s -- "$@"
    git -C "$repo" diff -- "$@"
    git -C "$repo" ls-files -o --exclude-standard -- "$@" | while IFS= read -r f; do
      stat -f '%N %z %m' "$repo/$f" 2>/dev/null || true
    done
    cat "$env_file"
  } | shasum -a 256 | cut -c1-16
}
current_fingerprint() {
  case "$1" in
    coordinator) fingerprint "${coordinator_paths[@]}" ;;
    app) fingerprint "${app_paths[@]}" ;;
  esac
}
record_start() {  # <name>: remember what this process was started from
  mkdir -p "$started_dir"
  printf '%s %s\n' "$(current_fingerprint "$1")" "$(git -C "$repo" rev-parse --short HEAD)" > "$started_dir/$1"
}
started_at() { [ -f "$started_dir/$1" ] && awk '{print $2}' "$started_dir/$1" || true; }
stale() {  # <name>: true when the running process was started from different sources
  [ -f "$started_dir/$1" ] || return 0
  [ "$(awk '{print $1}' "$started_dir/$1")" != "$(current_fingerprint "$1")" ] && return 0
  # Hot reload covers edits, not a restart's worth of pulled commits: renderer changes committed
  # since the app started make it stale too.
  local at; at="$(started_at "$1")"
  [ "$1" = app ] && [ -n "$at" ] &&
    [ -n "$(git -C "$repo" diff --name-only "$at" HEAD -- apps/desktop/src/renderer 2>/dev/null)" ]
}

base_branch="${LOOM_BASE_BRANCH:-main}"
update_checkout() {  # fast-forward to origin/<base> when that is safe; otherwise say what is missing
  [ "${LOOM_NO_UPDATE:-}" = 1 ] && return 0
  if ! git -C "$repo" fetch --quiet origin "$base_branch" 2>/dev/null; then
    echo "update: could not fetch origin/$base_branch; using the checked-out code"
    return 0
  fi
  local behind branch before
  behind="$(git -C "$repo" rev-list --count "HEAD..origin/$base_branch")"
  [ "$behind" = 0 ] && return 0
  branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD || echo detached)"
  if [ "$branch" != "$base_branch" ]; then
    echo "update: on $branch; $behind commit(s) on origin/$base_branch are not included (left as is)"
    return 0
  fi
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
    echo "update: $base_branch has uncommitted changes; not pulling $behind commit(s)"
    return 0
  fi
  before="$(git -C "$repo" rev-parse HEAD)"
  if ! git -C "$repo" merge --ff-only --quiet "origin/$base_branch" 2>/dev/null; then
    echo "update: $base_branch has diverged from origin/$base_branch; not pulling"
    return 0
  fi
  echo "update: $base_branch $(git -C "$repo" rev-parse --short "$before") -> $(git -C "$repo" rev-parse --short HEAD) ($behind commit(s))"
  if [ -n "$(git -C "$repo" diff --name-only "$before" HEAD -- pnpm-lock.yaml '*package.json')" ]; then
    echo "update: dependencies changed; pnpm install"
    (cd "$repo" && pnpm install --frozen-lockfile) || die "pnpm install failed after updating $base_branch"
  fi
}
freshness() {  # <name>: a phrase for status
  local at; at="$(started_at "$1")"
  if stale "$1"; then
    if [ -n "$at" ]; then echo "STALE (started from $at, sources changed since)"; else echo "STALE (no start record)"; fi
  else echo "up to date (started from $at)"; fi
}

# Process ownership comes from the instance's pane, never from a global command or port match.
pane_processes() {
  local pane_pid
  pane_pid="$(tm display-message -p -t "=$1:0.0" '#{pane_pid}' 2>/dev/null)" || return 0
  ps -axo pid=,ppid= | awk -v root="$pane_pid" '
    { parent[$1]=$2 }
    END { for (pid in parent) { p=pid; while (p && p != root && p in parent) p=parent[p]; if (p == root) print pid } }
  '
}
port_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}
coordinator_pids() {
  local owned pid
  owned="$(pane_processes loom-coordinator)"
  for pid in $(port_pids "$bind_port"); do
    if printf '%s\n' "$owned" | grep -qx "$pid"; then echo "$pid"; fi
  done
}
coordinator_running() { [ -n "$(coordinator_pids)" ]; }
app_processes() {
  local pid
  for pid in $(pane_processes loom-desktop); do
    if ps -p "$pid" -o args= | grep -Eq 'electron-vite.js dev|Electron.app/Contents/MacOS/Electron'; then
      echo "$pid"
    fi
  done
}
app_running() {
  local pid
  for pid in $(app_processes); do
    ps -p "$pid" -o args= | grep -q 'Electron.app/Contents/MacOS/Electron' && return 0
  done
  return 1
}
require_free_port() {
  [ -z "$(port_pids "$2")" ] || die "Port $2 is in use; set $1 to a different value"
}

start_coordinator() {
  if coordinator_running; then echo "coordinator: already running (pid $(coordinator_pids | head -1))"; return; fi
  tm kill-session -t "=loom-coordinator" 2>/dev/null || true
  require_free_port LOOM_BIND "$bind_port"
  require_free_port LOOM_MCP_PORT "$LOOM_MCP_PORT"
  require_free_port LOOM_HOOK_PORT "$LOOM_HOOK_PORT"
  record_start coordinator
  tm new-session -d -s loom-coordinator -n serve -c "$repo" \
    -e "LOOM_INSTANCE=$instance" -e "LOOM_DATA_ROOT=$root" \
    -e "LOOM_BIND=$LOOM_BIND" -e "LOOM_MCP_PORT=$LOOM_MCP_PORT" -e "LOOM_HOOK_PORT=$LOOM_HOOK_PORT" \
    -e "LOOM_RENDERER_PORT=$LOOM_RENDERER_PORT" -e "LOOM_DEBUG_PORT=${LOOM_DEBUG_PORT:-}" \
    "export PATH='$PATH'; set -a; . '$env_file'; set +a; exec pnpm loom serve 2>&1 | tee -a '$serve_log'"
  local i=0
  until coordinator_running || [ $i -ge 40 ]; do
    tm has-session -t "=loom-coordinator" 2>/dev/null || die "coordinator exited at once; last lines of $serve_log:"$'\n'"$(tail -n 5 "$serve_log")"
    sleep 1; i=$((i+1))
  done
  coordinator_running && echo "coordinator: up after ${i}s (log: $serve_log)" || die "coordinator did not start; see $serve_log"
}

stop_coordinator() {
  local pids; pids="$(coordinator_pids)"
  if [ -z "$pids" ]; then echo "coordinator: not running"; tm kill-session -t "=loom-coordinator" 2>/dev/null || true; return; fi
  # SIGTERM lets it stop its per-task app-servers; only a hung process is killed hard.
  kill $pids 2>/dev/null || true
  local i=0
  while [ $i -lt 40 ] && coordinator_running; do sleep 1; i=$((i+1)); done
  if coordinator_running; then echo "coordinator: not stopped after 40s, killing"; kill -9 $pids 2>/dev/null || true; sleep 1; fi
  tm kill-session -t "=loom-coordinator" 2>/dev/null || true
  echo "coordinator: stopped after ${i}s"
}

start_app() {
  if app_running; then echo "app: already running"; return; fi
  tm kill-session -t "=loom-desktop" 2>/dev/null || true
  require_free_port LOOM_RENDERER_PORT "$LOOM_RENDERER_PORT"
  [ -z "${LOOM_DEBUG_PORT:-}" ] || require_free_port LOOM_DEBUG_PORT "$LOOM_DEBUG_PORT"
  record_start app
  tm new-session -d -s loom-desktop -n dev -c "$repo" \
    -e "LOOM_INSTANCE=$instance" -e "LOOM_DATA_ROOT=$root" \
    -e "LOOM_BIND=$LOOM_BIND" -e "LOOM_MCP_PORT=$LOOM_MCP_PORT" -e "LOOM_HOOK_PORT=$LOOM_HOOK_PORT" \
    -e "LOOM_RENDERER_PORT=$LOOM_RENDERER_PORT" -e "LOOM_DEBUG_PORT=${LOOM_DEBUG_PORT:-}" \
    "export PATH='$PATH'; set -a; . '$env_file'; set +a; exec pnpm --filter @loom/desktop dev 2>&1 | tee -a '$app_log'"
  local i=0
  until app_running || [ $i -ge 60 ]; do
    tm has-session -t "=loom-desktop" 2>/dev/null || die "app exited at once; last lines of $app_log:"$'\n'"$(tail -n 5 "$app_log")"
    sleep 1; i=$((i+1))
  done
  app_running && echo "app: up after ${i}s (log: $app_log)" || die "app did not start; see $app_log"
}

stop_app() {
  local pids i=0
  pids="$(app_processes)"
  [ -z "$pids" ] || kill $pids 2>/dev/null || true
  while [ $i -lt 15 ] && app_running; do sleep 1; i=$((i+1)); done
  if app_running; then
    echo "app: not stopped after 15s, killing"
    pids="$(app_processes)"
    [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
  fi
  tm kill-session -t "=loom-desktop" 2>/dev/null || true
  echo "app: stopped after ${i}s"
}

sync() {  # start what is down, restart what is stale, leave the rest alone
  if ! coordinator_running; then start_coordinator
  elif stale coordinator; then echo "coordinator: stale, restarting"; stop_coordinator; start_coordinator
  else echo "coordinator: up to date (started from $(started_at coordinator))"; fi
  if ! app_running; then start_app
  elif stale app; then echo "app: stale, restarting"; stop_app; start_app
  else echo "app: up to date (started from $(started_at app))"; fi
}

status() {
  echo "instance: $instance; data root: $root; checkout: $repo"
  echo "ports: LOOM_BIND=$LOOM_BIND LOOM_MCP_PORT=$LOOM_MCP_PORT LOOM_HOOK_PORT=$LOOM_HOOK_PORT LOOM_RENDERER_PORT=$LOOM_RENDERER_PORT LOOM_DEBUG_PORT=${LOOM_DEBUG_PORT:-disabled}"
  if git -C "$repo" fetch --quiet origin "$base_branch" 2>/dev/null; then
    local behind; behind="$(git -C "$repo" rev-list --count "HEAD..origin/$base_branch")"
    [ "$behind" != 0 ] && echo "checkout: $(git -C "$repo" symbolic-ref --quiet --short HEAD || echo detached), $behind commit(s) behind origin/$base_branch"
  fi
  if coordinator_running; then echo "coordinator: running (pid $(coordinator_pids | head -1), ws://$LOOM_BIND), $(freshness coordinator)"; else echo "coordinator: not running"; fi
  if app_running; then echo "app: running, $(freshness app)"; else echo "app: not running"; fi
  # Each server is a node shim plus the codex binary; count binaries only, so one server reads x1.
  local servers; servers="$(ps -axo args= | grep "[a]pp-server --listen unix://$root/$instance/codex/" | grep -v '^node ' | grep -o 'codex/t-[a-z0-9]*' | sort | uniq -c | awk '{print "  " $2 " x" $1}' || true)"
  echo "task app-servers:${servers:+$'\n'$servers}"
  echo "windows: tmux -L $socket attach -t loom-coordinator | loom-desktop"
}

launcher_run() {  # <cmd...>: run detached for the Dock app, log, then notify with the last line
  local log="$root/$instance/launcher.log" outcome last
  (
    if "$0" "$@" > "$log" 2>&1; then outcome="done"; else outcome="FAILED"; fi
    last="$(tail -n 1 "$log" | tr -d '"\\')"
    osascript -e "display notification \"$last\" with title \"$launcher_name: $* $outcome\""
  ) </dev/null >/dev/null 2>&1 &
  echo "started: $*; log: $log"
}

install_launcher() {  # a Dock app: Status shows a dialog; everything else runs detached and notifies
  command -v osacompile >/dev/null || die "osacompile is required (macOS only)"
  local app="$HOME/Applications/$launcher_name.app" src
  src="$(mktemp -t loom-dev-launcher).applescript"
  mkdir -p "$HOME/Applications"
  cat > "$src" <<APPLESCRIPT
set repo to "$repo"
set labels to {"Sync: pull main, start what is down, restart what changed", "Status", "Start", "Restart everything", "Restart coordinator", "Restart app", "Stop"}
set commands to {"sync", "status", "up", "restart", "restart coordinator", "restart app", "down"}
set choice to choose from list labels with title "$launcher_name" with prompt "$instance instance at " & repo default items {item 1 of labels}
if choice is false then return
set command to ""
repeat with i from 1 to count of labels
  if item i of labels is item 1 of choice then set command to item i of commands
end repeat
set prefix to "cd " & quoted form of repo & " && LOOM_INSTANCE=" & quoted form of "$instance" & " LOOM_DATA_ROOT=" & quoted form of "$root" & " scripts/dev.sh "
if command is "status" then
  try
    set output to do shell script "/bin/zsh -lc " & quoted form of (prefix & "status 2>&1")
  on error message
    set output to "Failed:" & return & message
  end try
  display dialog output with title "$launcher_name: status" buttons {"OK"} default button "OK"
else
  -- Detached, so the launcher never beachballs during a restart; dev.sh notifies when done.
  do shell script "/bin/zsh -lc " & quoted form of (prefix & "launcher-run " & command)
  display notification "Started; another notification follows when it is done." with title "$launcher_name: " & command
end if
APPLESCRIPT
  rm -rf "$app"
  osacompile -o "$app" "$src" || die "osacompile failed; the script is at $src"
  rm -f "$src"
  echo "installed: $app (drag it to the Dock; every button runs scripts/dev.sh in $repo)"
}

cmd="${1:-status}"; what="${2:-all}"
case "$cmd" in
  sync) update_checkout ;;
esac
case "$cmd" in
  up) if [ "$what" != app ]; then start_coordinator; fi; if [ "$what" != coordinator ]; then start_app; fi ;;
  sync) sync ;;
  down) if [ "$what" != coordinator ]; then stop_app; fi; if [ "$what" != app ]; then stop_coordinator; fi ;;
  restart)
    case "$what" in
      app) stop_app; start_app ;;
      coordinator) stop_coordinator; start_coordinator ;;
      all) stop_app; stop_coordinator; start_coordinator; start_app ;;
      *) die "restart what? coordinator|app" ;;
    esac ;;
  status) status ;;
  logs) case "$what" in app) tail -n 50 -f "$app_log" ;; *) tail -n 50 -f "$serve_log" ;; esac ;;
  install-launcher) install_launcher ;;
  launcher-run) shift; launcher_run "$@" ;;
  *) die "usage: scripts/dev.sh up|sync|down|restart|status|logs|install-launcher [coordinator|app]" ;;
esac
