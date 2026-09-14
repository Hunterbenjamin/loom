#!/usr/bin/env bash
# The dev launcher: the coordinator and the desktop app for one instance, each in its own window
# on that instance's private tmux server, so they outlive any terminal and can be restarted
# independently. Nothing here touches the default tmux socket or another instance.
#
# Usage: scripts/dev.sh up|sync|down|restart|status|logs|install-launcher [coordinator|app]
#   scripts/dev.sh up                 start both (a running one is left alone)
#   scripts/dev.sh sync               the one safe button: start what is down, restart what is
#                                     stale, leave the rest alone (coordinator first)
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
# only what differs. The renderer hot-reloads, so it is not part of the app's fingerprint.
#
# Environment comes from $LOOM_DATA_ROOT/$LOOM_INSTANCE/env (default ~/.loom/dev/env), which must
# export LOOM_INSTANCE, LOOM_DATA_ROOT and LOOM_TOKEN at least.
set -euo pipefail

instance="${LOOM_INSTANCE:-dev}"
root="${LOOM_DATA_ROOT:-$HOME/.loom}"
env_file="$root/$instance/env"
socket="loom-$instance"
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
serve_log="$root/$instance/serve.log"
app_log="$root/$instance/desktop-dev.log"
started_dir="$root/$instance/started"
# A launcher started from Finder or launchd has a bare PATH and no .zshrc, so the places pnpm and
# Homebrew normally live are added here, and the resulting PATH is handed to every pane explicitly.
for dir in "${PNPM_HOME:-$HOME/Library/pnpm}" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$dir:$PATH" ;; esac
done
export PATH
tmux_bin="${LOOM_TMUX_BIN:-$(command -v tmux || true)}"

die() { printf 'dev.sh: %s\n' "$*" >&2; exit 1; }
[ -x "$tmux_bin" ] || die "tmux is required"
command -v pnpm >/dev/null || die "pnpm is not on PATH (looked in \$PNPM_HOME, ~/Library/pnpm, /opt/homebrew/bin)"
[ -f "$env_file" ] || die "no environment file at $env_file (export LOOM_INSTANCE, LOOM_DATA_ROOT, LOOM_TOKEN there)"
tm() { "$tmux_bin" -L "$socket" "$@"; }

# What each process is built from. Anything the coordinator or Electron's main process loads;
# the renderer (apps/desktop/src/renderer) hot-reloads and is deliberately absent.
coordinator_paths=(apps/coordinator packages package.json pnpm-lock.yaml pnpm-workspace.yaml)
app_paths=(apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared
  apps/desktop/electron.vite.config.ts apps/desktop/package.json packages pnpm-lock.yaml)

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
  [ "$(awk '{print $1}' "$started_dir/$1")" != "$(current_fingerprint "$1")" ]
}
freshness() {  # <name>: a phrase for status
  local at; at="$(started_at "$1")"
  if stale "$1"; then
    if [ -n "$at" ]; then echo "STALE (started from $at, sources changed since)"; else echo "STALE (no start record)"; fi
  else echo "up to date (started from $at)"; fi
}

port_pids() {  # every listener the coordinator holds: protocol, MCP host, hook receiver
  local pids=""
  for p in "${LOOM_BIND_PORT:-47800}" "${LOOM_MCP_PORT:-47801}" "${LOOM_HOOK_PORT:-47802}"; do
    pids="$pids $(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $2}')"
  done
  printf '%s\n' $pids | sort -u | sed '/^$/d'
}
coordinator_running() { [ -n "$(port_pids)" ]; }
app_running() { pgrep -f "electron-vite.js dev" >/dev/null 2>&1; }

start_coordinator() {
  if coordinator_running; then echo "coordinator: already running (pid $(port_pids | head -1))"; return; fi
  tm kill-session -t "=loom-coordinator" 2>/dev/null || true
  record_start coordinator
  tm new-session -d -s loom-coordinator -n serve -c "$repo" \
    "export PATH='$PATH'; set -a; . '$env_file'; set +a; exec pnpm loom serve 2>&1 | tee -a '$serve_log'"
  local i=0
  until coordinator_running || [ $i -ge 40 ]; do
    tm has-session -t "=loom-coordinator" 2>/dev/null || die "coordinator exited at once; last lines of $serve_log:"$'\n'"$(tail -n 5 "$serve_log")"
    sleep 1; i=$((i+1))
  done
  coordinator_running && echo "coordinator: up after ${i}s (log: $serve_log)" || die "coordinator did not start; see $serve_log"
}

stop_coordinator() {
  local pids; pids="$(port_pids)"
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
  record_start app
  tm new-session -d -s loom-desktop -n dev -c "$repo" \
    "export PATH='$PATH'; set -a; . '$env_file'; set +a; export LOOM_DEBUG_PORT='${LOOM_DEBUG_PORT:-}'; exec pnpm --filter @loom/desktop dev 2>&1 | tee -a '$app_log'"
  local i=0
  until pgrep -f 'Electron.app/Contents/MacOS/Electron' >/dev/null 2>&1 || [ $i -ge 60 ]; do
    tm has-session -t "=loom-desktop" 2>/dev/null || die "app exited at once; last lines of $app_log:"$'\n'"$(tail -n 5 "$app_log")"
    sleep 1; i=$((i+1))
  done
  echo "app: up after ${i}s (log: $app_log)"
}

stop_app() {
  pgrep -f "electron-vite.js dev" | xargs -I{} kill {} 2>/dev/null || true
  sleep 1
  pgrep -f 'Electron.app/Contents/MacOS/Electron' | xargs -I{} kill {} 2>/dev/null || true
  tm kill-session -t "=loom-desktop" 2>/dev/null || true
  echo "app: stopped"
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
  if coordinator_running; then echo "coordinator: running (pid $(port_pids | head -1), ws://127.0.0.1:${LOOM_BIND_PORT:-47800}), $(freshness coordinator)"; else echo "coordinator: not running"; fi
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
    osascript -e "display notification \"$last\" with title \"Loom Dev: $* $outcome\""
  ) </dev/null >/dev/null 2>&1 &
  echo "started: $*; log: $log"
}

install_launcher() {  # a Dock app: Status shows a dialog; everything else runs detached and notifies
  command -v osacompile >/dev/null || die "osacompile is required (macOS only)"
  local app="$HOME/Applications/Loom Dev.app" src
  src="$(mktemp -t loom-dev-launcher).applescript"
  mkdir -p "$HOME/Applications"
  cat > "$src" <<APPLESCRIPT
set repo to "$repo"
set labels to {"Sync: start what is down, restart what changed", "Status", "Start", "Restart everything", "Restart coordinator", "Restart app", "Stop"}
set commands to {"sync", "status", "up", "restart", "restart coordinator", "restart app", "down"}
set choice to choose from list labels with title "Loom Dev" with prompt "Dev instance at " & repo default items {item 1 of labels}
if choice is false then return
set command to ""
repeat with i from 1 to count of labels
  if item i of labels is item 1 of choice then set command to item i of commands
end repeat
set prefix to "cd " & quoted form of repo & " && scripts/dev.sh "
if command is "status" then
  try
    set output to do shell script "/bin/zsh -lc " & quoted form of (prefix & "status 2>&1")
  on error message
    set output to "Failed:" & return & message
  end try
  display dialog output with title "Loom Dev: status" buttons {"OK"} default button "OK"
else
  -- Detached, so the launcher never beachballs during a restart; dev.sh notifies when done.
  do shell script "/bin/zsh -lc " & quoted form of (prefix & "launcher-run " & command)
  display notification "Started; another notification follows when it is done." with title "Loom Dev: " & command
end if
APPLESCRIPT
  rm -rf "$app"
  osacompile -o "$app" "$src" || die "osacompile failed; the script is at $src"
  rm -f "$src"
  echo "installed: $app (drag it to the Dock; every button runs scripts/dev.sh in $repo)"
}

cmd="${1:-status}"; what="${2:-all}"
case "$cmd" in
  up) [ "$what" != app ] && start_coordinator; [ "$what" != coordinator ] && start_app ;;
  sync) sync ;;
  down) [ "$what" != coordinator ] && stop_app; [ "$what" != app ] && stop_coordinator ;;
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
