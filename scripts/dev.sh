#!/usr/bin/env bash
# The dev launcher: the coordinator and the desktop app for one instance, each in its own window
# on that instance's private tmux server, so they outlive any terminal and can be restarted
# independently. Nothing here touches the default tmux socket or another instance.
#
# Usage: scripts/dev.sh up|down|restart|status|logs [coordinator|app]
#   scripts/dev.sh up                 start both (a running one is left alone)
#   scripts/dev.sh restart            stop and start both, coordinator first
#   scripts/dev.sh restart app        just the desktop app (after a main-process change)
#   scripts/dev.sh restart coordinator
#   scripts/dev.sh down               stop both
#   scripts/dev.sh status             what is running, on which ports, with which app-servers
#   scripts/dev.sh logs [coordinator|app]   tail the log
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
tmux_bin="${LOOM_TMUX_BIN:-$(command -v tmux || true)}"

die() { printf 'dev.sh: %s\n' "$*" >&2; exit 1; }
[ -x "$tmux_bin" ] || die "tmux is required"
[ -f "$env_file" ] || die "no environment file at $env_file (export LOOM_INSTANCE, LOOM_DATA_ROOT, LOOM_TOKEN there)"
tm() { "$tmux_bin" -L "$socket" "$@"; }

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
  tm new-session -d -s loom-coordinator -n serve -c "$repo" \
    "set -a; . '$env_file'; set +a; exec pnpm loom serve 2>&1 | tee -a '$serve_log'"
  local i=0
  until coordinator_running || [ $i -ge 40 ]; do sleep 1; i=$((i+1)); done
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
  tm new-session -d -s loom-desktop -n dev -c "$repo" \
    "set -a; . '$env_file'; set +a; export LOOM_DEBUG_PORT='${LOOM_DEBUG_PORT:-}'; exec pnpm --filter @loom/desktop dev 2>&1 | tee -a '$app_log'"
  local i=0
  until pgrep -f 'Electron.app/Contents/MacOS/Electron' >/dev/null 2>&1 || [ $i -ge 60 ]; do sleep 1; i=$((i+1)); done
  echo "app: up after ${i}s (log: $app_log)"
}

stop_app() {
  pgrep -f "electron-vite.js dev" | xargs -I{} kill {} 2>/dev/null || true
  sleep 1
  pgrep -f 'Electron.app/Contents/MacOS/Electron' | xargs -I{} kill {} 2>/dev/null || true
  tm kill-session -t "=loom-desktop" 2>/dev/null || true
  echo "app: stopped"
}

status() {
  if coordinator_running; then echo "coordinator: running (pid $(port_pids | head -1), ws://127.0.0.1:${LOOM_BIND_PORT:-47800})"; else echo "coordinator: not running"; fi
  if app_running; then echo "app: running"; else echo "app: not running"; fi
  # Each server is a node shim plus the codex binary; count binaries only, so one server reads x1.
  local servers; servers="$(ps -axo args= | grep "[a]pp-server --listen unix://$root/$instance/codex/" | grep -v '^node ' | grep -o 'codex/t-[a-z0-9]*' | sort | uniq -c | awk '{print "  " $2 " x" $1}')"
  echo "task app-servers:${servers:+$'\n'$servers}"
  echo "windows: tmux -L $socket attach -t loom-coordinator | loom-desktop"
}

cmd="${1:-status}"; what="${2:-all}"
case "$cmd" in
  up) [ "$what" != app ] && start_coordinator; [ "$what" != coordinator ] && start_app ;;
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
  *) die "usage: scripts/dev.sh up|down|restart|status|logs [coordinator|app]" ;;
esac
