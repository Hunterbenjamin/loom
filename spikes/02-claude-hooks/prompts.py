"""Spike 02, Q3: send 100 varied prompts with `herdr agent prompt --wait` and check UserPromptSubmit payloads.

Usage:
  python3 prompts.py run   <agent> [first] [last]   # sends prompts, appends to $TMPDIR/loom-spike-02/bulk-sent.jsonl
  python3 prompts.py check <session-id>             # compares sent prompts with hooks.jsonl
"""

import hashlib
import json
import os
import random
import subprocess
import sys
import time

B = os.path.join(os.environ["TMPDIR"], "loom-spike-02")
SENT = os.path.join(B, "bulk-sent.jsonl")
TAIL = "Reply with just: ok"
WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split()


def words(rng, n_chars, line=0):
    out, cur = [], 0
    while cur < n_chars:
        w = rng.choice(WORDS)
        out.append(w)
        cur += len(w) + 1
    text = " ".join(out)[:n_chars]
    if line:
        text = "\n".join(text[i : i + line] for i in range(0, len(text), line))
    return text


SPECIAL = [
    "single 'quotes' and \"double quotes\"",
    "backticks `ls -la` and ```fenced``` text",
    "shell-looking $(whoami) and ${HOME} and $PATH",
    "backslashes \\n \\t \\\\ C:\\Users\\x",
    "emoji 👩‍💻🚀🎉 and flags 🇯🇵",
    "CJK 漢字かなカナ 한국어",
    "RTL עברית العربية mixed",
    "combining e\u0301 a\u0308 and zero-width[\u200b] and nbsp[\u00a0]",
    "math 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 ∑∫√∞ ≠ ≤",
    "format %s %d {0} {{braces}} <html>&amp;</html>",
    "a\ttab\tseparated\tline",
    "CRLF line one\r\nline two",
    "json {\"k\": [1, 2, {\"n\": null}]}",
    "trailing spaces   ",
    "quote mix '`\"'`\"",
    "markdown **bold** _it_ [link](http://example.invalid)",
    "semicolons; pipes | ampersands && redirects > /dev/null",
    "hash # and at @ and caret ^ and tilde ~",
    "emoji ZWJ family 👨‍👩‍👧‍👦 skin 👍🏽",
    "ellipsis… em—dash “smart quotes” ‘single’",
]


def build():
    rng = random.Random(2)
    ps = []

    def add(cat, text):
        ps.append({"id": f"P{len(ps):03d}", "cat": cat, "text": text})

    for i in range(20):
        add("short", f"[P{len(ps):03d}] {rng.choice(WORDS)} {TAIL}")
    for i in range(20):
        n = rng.randint(2, 8)
        body = "\n".join(("    " if j % 3 == 2 else "") + words(rng, rng.randint(10, 60)) for j in range(n))
        if i % 5 == 0:
            body = body + "\n\n" + words(rng, 30)  # blank line inside
        add("multiline", f"[P{len(ps):03d}] multi-line\n{body}\n{TAIL}")
    for i in range(15):
        add("2kb", f"[P{len(ps):03d}] " + words(rng, 2000, line=100 if i % 2 else 0) + f"\n{TAIL}")
    for i in range(10):
        add("20kb", f"[P{len(ps):03d}] " + words(rng, 20000, line=120) + f"\n{TAIL}")
    for s in SPECIAL:
        add("special", f"[P{len(ps):03d}] {s} — {TAIL}")
    for i in range(5):
        add("slash-word", f"/p{len(ps):03d}x not a real command. {TAIL}")
    for i in range(4):
        add("slash-path", f"/tmp/p{len(ps):03d}/file.txt is just a path. {TAIL}")
    for i in range(6):
        add("bang", f"!echo p{len(ps):03d}-bang")
    assert len(ps) == 100, len(ps)
    return ps


def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()[:16]


def run(agent, first, last):
    ps = build()[first : last + 1]
    for p in ps:
        t0 = int(time.time() * 1000)
        r = subprocess.run(
            ["herdr", "agent", "prompt", agent, p["text"], "--wait", "--timeout", "180000"],
            capture_output=True,
            text=True,
        )
        t1 = int(time.time() * 1000)
        try:
            d = json.loads(r.stdout)
            res = d["error"]["code"] if "error" in d else d["result"]["agent"]["agent_status"]
        except Exception:  # noqa: BLE001
            res = f"unparsed rc={r.returncode} {r.stdout[:80]!r} {r.stderr[:80]!r}"
        rec = {"id": p["id"], "cat": p["cat"], "len": len(p["text"]), "sha": sha(p["text"]), "send_ms": t0, "ret_ms": t1, "result": res}
        with open(SENT, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(json.dumps(rec), flush=True)
        if res != "idle":
            # Let a stalled/odd prompt settle before sending the next one.
            subprocess.run(["herdr", "agent", "wait", agent, "--timeout", "60000"], capture_output=True)
        time.sleep(0.5)


def check(sid):
    ps = {p["id"]: p for p in build()}
    sent = {}
    for line in open(SENT):
        r = json.loads(line)
        sent[r["id"]] = r  # last send wins
    ups = []
    for line in open(os.path.join(B, "hooks.jsonl")):
        r = json.loads(line)
        b = r["body"]
        if b.get("hook_event_name") == "UserPromptSubmit" and b.get("session_id") == sid:
            ups.append((r["recv_ms"], b.get("prompt", "")))
    by_cat = {}
    problems = []
    for pid, s in sent.items():
        p = ps[pid]
        exact = [t for _, t in ups if t == p["text"]]
        marker = pid.lower() if p["cat"] in ("slash-word", "slash-path", "bang") else f"[{pid}]"
        loose = [t for _, t in ups if marker in t.lower() or marker in t]
        c = by_cat.setdefault(p["cat"], {"sent": 0, "exactly_once_intact": 0, "herdr_results": {}})
        c["sent"] += 1
        c["herdr_results"][s["result"]] = c["herdr_results"].get(s["result"], 0) + 1
        if len(exact) == 1 and len(loose) == 1:
            c["exactly_once_intact"] += 1
        else:
            got = loose[0] if loose else None
            diff = None
            if got is not None:
                i = next((k for k in range(min(len(got), len(p["text"]))) if got[k] != p["text"][k]), min(len(got), len(p["text"])))
                diff = {"at": i, "sent": p["text"][max(0, i - 15) : i + 25], "got": got[max(0, i - 15) : i + 25], "sent_len": len(p["text"]), "got_len": len(got)}
            problems.append({"id": pid, "cat": p["cat"], "exact": len(exact), "loose": len(loose), "herdr": s["result"], "diff": diff})
    total = sum(c["exactly_once_intact"] for c in by_cat.values())
    print(json.dumps(by_cat, indent=1, ensure_ascii=False))
    print(f"TOTAL exactly-once-intact: {total}/{len(sent)}   UserPromptSubmit payloads in session: {len(ups)}")
    for pr in problems:
        print(json.dumps(pr, ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1] == "run":
        run(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 0, int(sys.argv[4]) if len(sys.argv) > 4 else 99)
    else:
        check(sys.argv[2])
