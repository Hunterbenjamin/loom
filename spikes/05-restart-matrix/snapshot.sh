#!/bin/sh
# One record of everything a reconciler could read. snapshot.sh [label]
. "$(dirname "$0")/env.sh"
LABEL="${1:-snapshot}"
printf '== %s  %s\n' "$LABEL" "$(date +%H:%M:%S)"

printf 'herdr-server:'
pgrep -f "herdr --session $SESSION server" | tr '\n' ' '; echo
printf 'codex-app-server:'
pgrep -f "app-server --listen unix://$CODEX_SOCK" | tr '\n' ' '; echo

herdr agent list 2>/dev/null | python3 "$(dirname "$0")/fmt.py" agents
for p in w1:p1 w1:p2 w1:p3 w1:p4; do
  herdr pane process-info --pane "$p" 2>/dev/null | python3 "$(dirname "$0")/fmt.py" pane
done
claude agents --json 2>/dev/null | python3 "$(dirname "$0")/fmt.py" claude "$(cat "$SPIKE/claude-session-id" 2>/dev/null)"
if [ -n "${CODEX_THREAD:-}" ]; then
  node "$(dirname "$0")/thread-read.mjs" "$CODEX_SOCK" "$CODEX_THREAD" --turns 2>/dev/null \
    | python3 "$(dirname "$0")/fmt.py" thread
fi
