#!/bin/sh
# Put both agents mid-turn on a long, harmless tool call.
. "$(dirname "$0")/env.sh"
TAG="${1:-X}"
# A bare `sleep` is refused by some harnesses; python's sleep is not.
herdr agent prompt s05-claude "Use the Bash tool to run this exact command: python3 -c 'import time; time.sleep(30)' . Then reply exactly: CLAUDE_$TAG" >/dev/null 2>&1 &
herdr agent prompt s05-codex "Run the shell command: sleep 30. Then reply exactly: CODEX_$TAG" >/dev/null 2>&1 &
wait

# A trial is only mid-turn if both providers actually started a turn; say so.
sleep 8
claude agents --json 2>/dev/null | python3 "$(dirname "$0")/fmt.py" claude "$(cat "$SPIKE/claude-session-id")"
node "$(dirname "$0")/thread-read.mjs" "$SPIKE/codex.sock" "$(cat "$SPIKE/codex-thread-id")" --turns 2>/dev/null \
  | python3 "$(dirname "$0")/fmt.py" thread
