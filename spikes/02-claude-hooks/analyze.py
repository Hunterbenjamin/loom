"""Spike 02: merge hook payloads, status samples and action markers into one timeline.

Usage: python3 analyze.py <dir> [session-id-prefix] [from_ms] [to_ms]
Reads <dir>/hooks.jsonl, <dir>/status.jsonl, <dir>/markers.jsonl.
The "derived" column is the status a coordinator would compute from hooks alone.
"""

import json
import os
import sys

d = sys.argv[1]
sid = sys.argv[2] if len(sys.argv) > 2 else ""
lo = int(sys.argv[3]) if len(sys.argv) > 3 else 0
hi = int(sys.argv[4]) if len(sys.argv) > 4 else 1 << 62


def load(name):
    p = os.path.join(d, name)
    return [json.loads(line) for line in open(p)] if os.path.exists(p) else []


def derive(ev, b, cur):
    """Hook event -> run status. Subagent events never change the main session's status."""
    if b.get("agent_id") and ev not in ("SubagentStart", "SubagentStop"):
        return cur
    nt = b.get("notification_type")
    # AskUserQuestion arrives as PreToolUse + PermissionRequest; it means "needs input", not a permission.
    ask = b.get("tool_name") == "AskUserQuestion"
    return {
        "SessionStart": "idle",
        "UserPromptSubmit": "working",
        "PreToolUse": "needs_input" if ask else "working",
        "PermissionRequest": "needs_input" if ask else "needs_permission",
        "PermissionDenied": "working",
        "PostToolUse": "working",
        "PostToolUseFailure": "working",
        "Stop": "idle",
        "StopFailure": "errored",
        "SessionEnd": "ended",
        "Notification": {
            "permission_prompt": "needs_permission",
            "idle_prompt": "idle",
            "elicitation_dialog": "needs_input",
            "agent_needs_input": "needs_input",
        }.get(nt, cur),
    }.get(ev, cur)


rows = []
for r in load("hooks.jsonl"):
    b = r["body"]
    if "hook_event_name" not in b or not b.get("session_id", "").startswith(sid):
        continue
    ev = b["hook_event_name"]
    detail = (
        b.get("tool_name")
        or b.get("notification_type")
        or b.get("source")
        or b.get("reason")
        or b.get("error_type")
        or (b.get("prompt", "")[:40].replace("\n", "⏎") if ev == "UserPromptSubmit" else "")
        or ""
    )
    if b.get("agent_id"):
        detail += f" [sub {b.get('agent_type') or '?'}]"
    rows.append((r["recv_ms"], "hook", ev, detail, b))
for r in load("status.jsonl"):
    rows.append((r["t_ms"], "poll", f"herdr={r['herdr']}", f"claude={','.join(r['claude']) or '-'}", None))
for r in load("markers.jsonl"):
    rows.append((r["t_ms"], "MARK", r["mark"], "", None))

rows = [x for x in sorted(rows, key=lambda x: x[0]) if lo <= x[0] <= hi]
cur = "?"
t0 = rows[0][0] if rows else 0
for t, kind, a, b, body in rows:
    if kind == "hook":
        cur = derive(a, body, cur)
    print(f"{(t - t0) / 1000:8.3f}  {kind:4}  {a:34} {b[:60]:60} derived={cur}")
