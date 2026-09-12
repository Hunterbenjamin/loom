#!/bin/sh
# Start / stop the spike's own headless Herdr server.
#   server.sh start [true|false]   resume_agents_on_restore
#   server.sh stop
#   server.sh pid
set -e
. "$(dirname "$0")/env.sh"

case "$1" in
  start)
    mkdir -p "$SPIKE/herdr" "$SPIKE/logs"
    printf '[session]\nresume_agents_on_restore = %s\n' "${2:-true}" > "$SPIKE/herdr/config.toml"
    scrub HERDR_CONFIG_PATH="$SPIKE/herdr/config.toml" \
      nohup herdr --session "$SESSION" server >>"$SPIKE/logs/server.log" 2>&1 &
    for _ in $(seq 1 50); do
      [ -S "$HERDR_SOCKET_PATH" ] && herdr status server >/dev/null 2>&1 && break
      sleep 0.2
    done
    herdr status server | sed -n '1,3p'
    ;;
  stop) herdr --session "$SESSION" server stop ;;
  pid)
    pgrep -f "herdr --session $SESSION server" | while read -r p; do
      # only report processes whose argv names our session
      ps -o pid=,args= -p "$p"
    done
    ;;
  *) echo "usage: server.sh start|stop|pid" >&2; exit 2 ;;
esac
