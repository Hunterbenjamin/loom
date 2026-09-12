#!/bin/sh
# fault.sh <stop|kill> <idle|midturn> <resume-true|resume-false> <tag>
# Applies one fault to the spike's own Herdr server and records both sides of it.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
. "$D/env.sh"
MODE="$1"; MOMENT="$2"; RESUME="$3"; TAG="$4"
export CODEX_THREAD="$(cat "$SPIKE/codex-thread-id" 2>/dev/null)"

echo "#### fault=$MODE moment=$MOMENT resume_agents_on_restore=$RESUME tag=$TAG"

if [ "$MOMENT" = midturn ]; then
  "$D/prompt.sh" "$TAG" >/dev/null 2>&1 &
  sleep 10
fi
"$D/snapshot.sh" "$TAG-before"

# PIDs to compare afterwards, captured while the server still answers.
PANE_CLAUDE=$(herdr agent get s05-claude 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["agent"]["pane_id"])' 2>/dev/null)
PANE_CODEX=$(herdr agent get s05-codex 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["agent"]["pane_id"])' 2>/dev/null)
CLAUDE_PID_BEFORE=$(herdr pane process-info --pane "$PANE_CLAUDE" 2>/dev/null | python3 -c 'import json,sys;print((json.load(sys.stdin)["result"]["process_info"]["foreground_processes"] or [{}])[0].get("pid"))' 2>/dev/null)
CODEX_PID_BEFORE=$(herdr pane process-info --pane "$PANE_CODEX" 2>/dev/null | python3 -c 'import json,sys;print((json.load(sys.stdin)["result"]["process_info"]["foreground_processes"] or [{}])[0].get("pid"))' 2>/dev/null)
SHELL1_BEFORE=$(herdr pane process-info --pane "$PANE_CLAUDE" 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["process_info"]["shell_pid"])' 2>/dev/null)
echo "panes-before claude=$PANE_CLAUDE codex=$PANE_CODEX"
echo "pids-before claude=$CLAUDE_PID_BEFORE codex=$CODEX_PID_BEFORE shell1=$SHELL1_BEFORE"

SERVER_PID=$(pgrep -f "herdr --session $SESSION server" | head -1)
# Guard: only ever touch a process whose argv names our own session.
case "$(ps -o args= -p "$SERVER_PID" 2>/dev/null)" in
  *"--session $SESSION server"*) ;;
  *) echo "refusing: pid $SERVER_PID is not the $SESSION server"; exit 1 ;;
esac
echo "server-pid=$SERVER_PID argv=$(ps -o args= -p "$SERVER_PID")"

T0=$(python3 -c 'import time;print(time.time())')
if [ "$MODE" = stop ]; then
  herdr --session "$SESSION" server stop
else
  kill -9 "$SERVER_PID"
fi

for _ in $(seq 1 40); do
  pgrep -f "herdr --session $SESSION server" >/dev/null || break
  sleep 0.25
done
echo "server-down-after=$(python3 -c "import time;print(round(time.time()-$T0,2))")s"

echo "--- with the server down ---"
for p in $CLAUDE_PID_BEFORE $CODEX_PID_BEFORE $SHELL1_BEFORE; do
  if ps -o pid= -p "$p" >/dev/null 2>&1; then
    echo "pid $p ALIVE: $(ps -o args= -p "$p" | cut -c1-70)"
  else
    echo "pid $p GONE"
  fi
done
[ -n "$CODEX_THREAD" ] && node "$D/thread-read.mjs" "$SPIKE/codex.sock" "$CODEX_THREAD" --turns 2>/dev/null | python3 "$D/fmt.py" thread
claude agents --json 2>/dev/null | python3 "$D/fmt.py" claude "$(cat "$SPIKE/claude-session-id")"

echo "--- restarting the server ---"
T1=$(python3 -c 'import time;print(time.time())')
"$D/server.sh" start "$RESUME" >/dev/null 2>&1
echo "server-up-after=$(python3 -c "import time;print(round(time.time()-$T1,2))")s"
sleep 3
"$D/snapshot.sh" "$TAG-after"
herdr pane list 2>/dev/null | python3 "$D/fmt.py" panes
echo "total-fault-to-server-up=$(python3 -c "import time;print(round(time.time()-$T0,2))")s"
