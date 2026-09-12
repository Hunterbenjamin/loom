# Shared environment for spike 05. Source it: . spikes/05-restart-matrix/env.sh
SPIKE="${TMPDIR%/}/loom-spike-05"
SESSION=loom-s05
SESSION_DIR="$HOME/.config/herdr/sessions/$SESSION"
export HERDR_SOCKET_PATH="$SESSION_DIR/herdr.sock"
CODEX_SOCK="$SPIKE/codex.sock"

# Herdr and Claude Code both export state into a pane's environment. Anything we
# start for the spike must not inherit it (spike 03: an inherited
# CLAUDE_CODE_CHILD_SESSION turns off transcript saving).
scrub() {
  env -u HERDR_BIN_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH \
      -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_CONFIG_PATH \
      -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET \
      -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID \
      -u CLAUDE_CODE_EXECPATH -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID \
      -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED \
      -u CLAUDE_PID -u CLAUDE_EFFORT "$@"
}

# herdr CLI aimed at the spike session.
h() { herdr "$@"; }
