#!/bin/sh
# Fresh, isolated fixture. Never modifies global Codex/Herdr configuration.
set -eu
: "${LOOM_SPIKE_ROOT:?Set LOOM_SPIKE_ROOT to $TMPDIR/loom-spike-01}"
case "$LOOM_SPIKE_ROOT" in /*/loom-spike-01) ;; *) echo "Expected an absolute .../loom-spike-01 path" >&2; exit 1;; esac
if [ -e "$LOOM_SPIKE_ROOT" ]; then
  echo "Refusing to overwrite an existing experiment. Use a fresh temporary parent." >&2
  exit 1
fi
credential_source="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [ ! -f "$credential_source" ]; then
  echo "Existing Codex CLI credentials are required; no credential contents are inspected." >&2
  exit 1
fi
mkdir -p "$LOOM_SPIKE_ROOT/repo" "$LOOM_SPIKE_ROOT/home" "$LOOM_SPIKE_ROOT/logs"
ln -s "$credential_source" "$LOOM_SPIKE_ROOT/home/auth.json"
cat > "$LOOM_SPIKE_ROOT/home/config.toml" <<'CONFIG'
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
[analytics]
enabled = false
CONFIG
printf '# Isolated Loom spike fixture\n' > "$LOOM_SPIKE_ROOT/repo/README.md"
printf 'alpha\nbeta\n' > "$LOOM_SPIKE_ROOT/repo/sample.txt"
git init -q "$LOOM_SPIKE_ROOT/repo"
cat > "$LOOM_SPIKE_ROOT/server.sh" <<'SERVER'
#!/bin/sh
set -eu
root="${0%/*}"
case "$root" in /*) ;; *) echo "Run server.sh by absolute path" >&2; exit 1;; esac
export CODEX_HOME="$root/home"
exec codex app-server --listen "unix://$root/codex.sock" -c model="gpt-5.6-luna" 2>> "$root/logs/server.stderr"
SERVER
printf 'Fixture ready: %s\n' "$LOOM_SPIKE_ROOT"
