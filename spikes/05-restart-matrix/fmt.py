"""Trim the JSON that snapshot.sh collects down to one line per fact."""
import json
import sys

what = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    if what != "pane":
        print(f"{what}: unreachable")
    sys.exit(0)

if what == "agents":
    for a in data.get("result", {}).get("agents", []):
        s = a.get("agent_session") or {}
        print(f"herdr-agent {(a.get('name') or '(unnamed)'):<11} pane={a['pane_id']} kind={a['agent']:<6} "
              f"status={a['agent_status']:<8} ready={a.get('interactive_ready')} session={s.get('value')}")
elif what == "pane":
    d = data.get("result", {}).get("process_info")
    if d:
        fg = (d.get("foreground_processes") or [{}])[0]
        print(f"pane {d['pane_id']} shell_pid={d['shell_pid']} fg_pid={fg.get('pid')} argv={fg.get('cmdline')}")
elif what == "claude":
    # Only our own session: the list also holds the user's other Claude sessions.
    want = sys.argv[2] if len(sys.argv) > 2 else None
    rows = [r for r in (data if isinstance(data, list) else []) if r.get("sessionId") == want]
    for r in rows:
        print(f"claude-agents id={r.get('sessionId')} kind={r.get('kind')} "
              f"status={r.get('status')} pid={r.get('pid')}")
    if not rows:
        print("claude-agents (our session absent)")
elif what == "panes":
    for p in data.get("result", {}).get("panes", []):
        print(f"restored-pane {p['pane_id']} tab={p['tab_id']} ws={p['workspace_id']} "
              f"cwd={p['cwd']} agent_status={p['agent_status']}")
elif what == "thread":
    t = data.get("thread", {})
    turns = t.get("turns") or []
    def turn_status(x):
        st = x.get("status")
        return st.get("type") if isinstance(st, dict) else st
    tail = ", ".join(f"{str(x.get('id'))[-6:]}={turn_status(x)}" for x in turns[-3:])
    print(f"thread {t.get('id')} status={json.dumps(t.get('status'))} turns[-3]: {tail}")
