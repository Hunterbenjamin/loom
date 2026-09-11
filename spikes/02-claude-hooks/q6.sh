#!/bin/sh
# Spike 02, Q6: session behaviour when the hook endpoint is up, down (connection refused) or hung (accepts, never answers).
# Needs agent s02-c already running with hooks-q6.settings.json (port 47803, every hook timeout 2 s) in pane $(cat $B/PANE_C).
# Results: $TMPDIR/loom-spike-02/q6.jsonl
set -u
D="$(cd "$(dirname "$0")" && pwd)"
B="${TMPDIR}loom-spike-02"
A=s02-c
PORT=47803
PANE=$(cat "$B/PANE_C")
now() { python3 -c 'import time;print(int(time.time()*1000))'; }
st() { python3 -c 'import json,sys;d=json.load(sys.stdin);e=d.get("error");print(e["code"] if e else d["result"].get("agent",{}).get("agent_status","ok"))'; }
rec() { echo "$1 $2 $3ms"; echo "{\"cond\":\"$1\",\"what\":\"$2\",\"ms\":$3}" >>"$B/q6.jsonl"; "$D/mark.sh" "Q6 $1 $2 $3ms"; }
kill_server() { lsof -ti "tcp:$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 0.5; }
start_server() { HANG=$1 nohup node "$D/hook-server.mjs" $PORT "$B/hooks-q6.jsonl" >/dev/null 2>&1 & sleep 0.8; }
turn() {
  t0=$(now)
  r=$(herdr agent prompt $A "Use the Bash tool to run: sleep 1   Then reply: done" --wait --timeout 120000 | st)
  rec "$1" "turn:$r" $(($(now) - t0))
}
screen() { herdr agent read $A --source visible | grep -v '^[[:space:]]*$' | tail -"${1:-10}"; }
exit_agent() {
  t0=$(now)
  herdr agent prompt $A "/exit" >/dev/null
  until herdr agent get $A 2>&1 | grep -q agent_not_found; do sleep 0.1; done
  rec "$1" "exit" $(($(now) - t0))
}
start_agent() {
  sid=$(uuidgen | tr A-Z a-z)
  echo "$sid" >>"$B/SID_C_ALL"
  sleep 1
  t0=$(now)
  r=$(herdr agent start $A --kind claude --pane "$PANE" --timeout 60000 -- --settings "$D/hooks-q6.settings.json" --session-id "$sid" --model haiku --debug-file "$B/debug-c-$1.log" | st)
  rec "$1" "start:$r" $(($(now) - t0))
}

for i in 1 2 3; do turn up; done

kill_server
for i in 1 2 3; do turn down; done
echo "--- screen (down)"; screen 12

start_server 1
for i in 1 2 3; do turn hang; done
echo "--- screen (hang)"; screen 12

exit_agent hang
start_agent hang
kill_server
exit_agent down
start_agent down
turn down
start_server 0
exit_agent up
start_agent up
turn up
echo "--- screen (up again)"; screen 8
