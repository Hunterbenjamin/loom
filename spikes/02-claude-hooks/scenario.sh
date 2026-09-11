#!/bin/sh
# Spike 02, Q2-Q4 scripted scenario against a running Herdr agent (default s02-a).
# Run step 1 first (permission + prompt-while-blocked), then the rest continues from the question dialog.
# Every action is marked in $TMPDIR/loom-spike-02/markers.jsonl; view with analyze.py.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
A=${AGENT:-s02-a}
m() { "$D/mark.sh" "$1"; echo "[mark] $1"; }
st() { python3 -c 'import json,sys;d=json.load(sys.stdin);e=d.get("error");print(e["code"] if e else d["result"].get("agent",{}).get("agent_status","ok"))'; }

if [ "${1:-}" = step1 ]; then
  m "Q2.1 send permission prompt"
  herdr agent prompt "$A" "Use the Bash tool to run exactly: touch perm-test.txt   Then reply: done" --wait --timeout 60000 | st
  sleep 1
  m "Q3 prompt while blocked"; herdr agent prompt "$A" "hello while blocked" --wait --timeout 10000 | st
  m "Q2.1 approve (enter)"; herdr agent send-keys "$A" enter | st
  herdr agent wait "$A" --until idle --timeout 60000 | st
  sleep 2
  m "Q2.2 send question prompt"
  herdr agent prompt "$A" "Use the AskUserQuestion tool to ask me one question: do I prefer tea or coffee? Offer those two options." --wait --timeout 60000 | st
  exit 0
fi

m "Q2.2 answer question (enter)"; herdr agent send-keys "$A" enter | st
herdr agent wait "$A" --until idle --timeout 60000 | st; m "Q2.2 idle"
sleep 2
m "Q2.3 normal prompt"
herdr agent prompt "$A" "What is 2+2? Reply with just the number." --wait --timeout 60000 | st; m "Q2.3 returned"
sleep 2
m "Q3w long turn (sleep 15)"
herdr agent prompt "$A" "Use the Bash tool to run: sleep 15   Then reply: slept" --wait --until working --timeout 30000 | st
sleep 4
m "Q3w prompt while working"
herdr agent prompt "$A" "Second prompt sent while working. Reply with just: queued-ok" --wait --timeout 90000 | st
m "Q3w prompt-while-working returned"
herdr agent wait "$A" --until idle --timeout 90000 | st; m "Q3w idle"
sleep 2
# Claude Code's Bash tool refuses a standalone `sleep 30` ("Blocked: standalone sleep 30"), so interrupt a sleep 15.
m "Q4a long tool (sleep 15)"
herdr agent prompt "$A" "Use the Bash tool to run: sleep 15   Then reply: slept" --wait --until working --timeout 30000 | st
sleep 4
m "Q4a esc during tool"; herdr agent send-keys "$A" esc | st
herdr agent wait "$A" --until idle --timeout 30000 | st; m "Q4a idle"
sleep 3
m "Q4b long text"
herdr agent prompt "$A" "Write a 600-word story about a lighthouse keeper. Do not use any tools." --wait --until working --timeout 30000 | st
sleep 2.5
m "Q4b esc during streaming"; herdr agent send-keys "$A" esc | st
herdr agent wait "$A" --until idle --timeout 30000 | st; m "Q4b idle"
sleep 3
m "Q4c prompt after interrupt"; herdr agent prompt "$A" "Reply with just: ok" --wait --timeout 60000 | st; m "Q4c idle"
sleep 2
m "Q2.5 approval-gap prompt"
herdr agent prompt "$A" "Use the Bash tool to run exactly: sleep 6 && touch gap.txt   Then reply: done" --wait --timeout 60000 | st
sleep 1
m "Q2.5 approve (enter)"; herdr agent send-keys "$A" enter | st
herdr agent wait "$A" --until idle --timeout 60000 | st; m "Q2.5 idle"
herdr agent read "$A" --source recent --lines 80 | grep -v '^[[:space:]]*$' | tail -45
