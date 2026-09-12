#!/bin/sh
# The reconciler's recovery step, written as shell: put both agents back into a
# working, attachable state from stored IDs plus read-only discovery.
#   recover.sh [claude|codex|both]
set -u
D="$(cd "$(dirname "$0")" && pwd)"
. "$D/env.sh"
WHICH="${1:-both}"
CLAUDE_SID="$(cat "$SPIKE/claude-session-id")"
CODEX_THREAD="$(cat "$SPIKE/codex-thread-id")"
T0=$(python3 -c 'import time;print(time.time())')

# 1. Is the Herdr server up? (stored: session name)
herdr status server >/dev/null 2>&1 || "$D/server.sh" start true >/dev/null 2>&1

# 2. Find the pane for each agent by worktree path — the join key. Read-only.
find_pane() {
  out=$(herdr agent list 2>/dev/null | python3 -c "
import json,sys
want_kind, want_cwd = sys.argv[1], sys.argv[2]
for a in json.load(sys.stdin)['result']['agents']:
    if a['agent'] == want_kind and a['cwd'] == want_cwd:
        print(a['pane_id'], a.get('name'), a['agent_status'], (a.get('agent_session') or {}).get('value'))
        break
" "$1" "$(cd "$SPIKE/repo" && pwd -P)")
  [ -n "$out" ] && { echo "$out"; return; }
  # No agent entry (resume_agents_on_restore = false): pick a bare-shell pane in
  # our worktree, in pane order, one per agent kind.
  herdr pane list 2>/dev/null | python3 -c "
import json,sys
want_cwd = sys.argv[1]
slot = {'claude': 0, 'codex': 1}[sys.argv[2]]
panes = [p for p in json.load(sys.stdin)['result']['panes'] if p['cwd'] == want_cwd]
print(panes[slot]['pane_id'] if len(panes) > slot else '')
" "$(cd "$SPIKE/repo" && pwd -P)" "$1"
}

# Quit whatever Herdr relaunched (its command line is not the one we stored) and
# start the agent again ourselves. Never `exit` the pane's shell: that closes the
# pane and loses the layout.
quit_agent() {
  case "$2" in
    claude) herdr pane send-text "$1" "/exit" >/dev/null 2>&1
            sleep 1; herdr pane send-keys "$1" enter >/dev/null 2>&1 ;;
    codex)  herdr pane send-keys "$1" ctrl+c >/dev/null 2>&1
            sleep 1; herdr pane send-keys "$1" ctrl+c >/dev/null 2>&1 ;;
  esac
  sleep 2
  herdr pane release-agent --source loom --agent "$3" "$1" >/dev/null 2>&1 || true
}

relaunch() {  # name kind pane args...
  name="$1"; kind="$2"; pane="$3"; shift 3
  quit_agent "$pane" "$kind" "$name"
  herdr agent start "$name" --kind "$kind" --pane "$pane" --timeout 8000 -- "$@" 2>&1 | cut -c1-90
  # A resumed Codex TUI can look "working" to Herdr's title-based detection, so
  # `agent start` may report a readiness timeout even though the agent is up.
  # Name it anyway: the name is how Loom addresses the pane afterwards.
  herdr agent rename "$pane" "$name" >/dev/null 2>&1 || true
}

if [ "$WHICH" = claude ] || [ "$WHICH" = both ]; then
  set -- $(find_pane claude); PANE="${1:-w1:p1}"
  echo "claude pane=$PANE session=$CLAUDE_SID"
  relaunch s05-claude claude "$PANE" --resume "$CLAUDE_SID" \
    --settings "$SPIKE/loom.settings.json" --model haiku
fi

if [ "$WHICH" = codex ] || [ "$WHICH" = both ]; then
  set -- $(find_pane codex); PANE="${1:-w1:p2}"
  echo "codex pane=$PANE thread=$CODEX_THREAD"
  # The app-server owns the thread and lives outside Herdr; restart it only if gone.
  pgrep -f "app-server --listen unix://$CODEX_SOCK" >/dev/null 2>&1 || {
    (cd "$SPIKE/repo" && scrub CODEX_HOME="$SPIKE/home" HERDR_ENV=1 \
       HERDR_SOCKET_PATH="$HERDR_SOCKET_PATH" HERDR_PANE_ID="$PANE" \
       nohup codex app-server --listen "unix://$CODEX_SOCK" >>"$SPIKE/logs/codex-app-server.log" 2>&1 &)
    sleep 2
  }
  relaunch s05-codex codex "$PANE" resume "$CODEX_THREAD" --remote "unix://$CODEX_SOCK"
  sleep 2
  # Herdr only learns a Codex thread id from the integration's SessionStart hook,
  # which does not fire on resume (and runs in the app-server, not the pane).
  # Loom knows the id, so report it: --source must be the integration id.
  herdr pane report-agent-session --source herdr:codex --agent codex \
    --agent-session-id "$CODEX_THREAD" --session-start-source resume \
    --seq "$(python3 -c 'import time;print(time.time_ns())')" "$PANE" >/dev/null 2>&1
fi

echo "recover-seconds=$(python3 -c "import time;print(round(time.time()-$T0,2))")"
