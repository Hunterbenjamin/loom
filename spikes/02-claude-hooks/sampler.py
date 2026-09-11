"""Spike 02: poll Herdr and `claude agents --json` and log status changes with timestamps.

Usage: python3 sampler.py <herdr-agent-name> <cwd-substring> <out.jsonl> [interval_s]
Only agents whose cwd contains <cwd-substring> are recorded.
"""

import json
import subprocess
import sys
import time

name, cwd_part, out = sys.argv[1], sys.argv[2], sys.argv[3]
interval = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25


def run(cmd):
    try:
        return json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


last = None
with open(out, "a") as f:
    while True:
        t0 = time.time()
        h = run(["herdr", "agent", "get", name])
        agent = (h.get("result") or {}).get("agent") or {}
        err = h.get("error")
        herdr = agent.get("agent_status") or (err.get("code") if isinstance(err, dict) else err) or "?"
        c = run(["claude", "agents", "--json"])
        claude = sorted(
            f"{e.get('sessionId', '')[:8]}:{e.get('status')}"
            for e in (c if isinstance(c, list) else [])
            if cwd_part in e.get("cwd", "")
        )
        state = {"herdr": herdr, "claude": claude}
        if state != last:
            f.write(json.dumps({"t_ms": int(t0 * 1000), "poll_ms": int((time.time() - t0) * 1000), **state}) + "\n")
            f.flush()
            last = state
        time.sleep(max(0.0, interval - (time.time() - t0)))
