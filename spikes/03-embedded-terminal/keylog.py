#!/usr/bin/env python3
"""Raw input logger for spike 03. Run inside the Herdr pane that the embedded terminal attaches to.

Turns on the requested terminal modes, then prints (and appends to $KEYLOG) every chunk of bytes
it receives, so we can see exactly what reaches the program through `herdr agent attach`.
Flags: --paste (2004), --mouse (1000+1006), --focus (1004), --kitty (CSI >1u), --mok (modifyOtherKeys 2)
Ctrl+C (legacy 0x03 or kitty CSI 99;5u) quits.
"""
import os
import sys
import termios
import time
import tty

flags = set(sys.argv[1:])
log = os.environ.get("KEYLOG", "/tmp/keylog.txt")
on, off = [], []
if "--paste" in flags:
    on.append("\x1b[?2004h"); off.append("\x1b[?2004l")
if "--mouse" in flags:
    on.append("\x1b[?1000h\x1b[?1006h"); off.append("\x1b[?1006l\x1b[?1000l")
if "--focus" in flags:
    on.append("\x1b[?1004h"); off.append("\x1b[?1004l")
if "--kitty" in flags:
    on.append("\x1b[>1u"); off.append("\x1b[<u")
if "--mok" in flags:
    on.append("\x1b[>4;2m"); off.append("\x1b[>4;0m")

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
sys.stdout.write("".join(on) + "keylog ready " + " ".join(sorted(flags)) + "\r\n")
sys.stdout.flush()
with open(log, "a") as f:
    f.write(f"--- start {time.time():.3f} {sorted(flags)}\n")
try:
    while True:
        data = os.read(fd, 4096)
        rep = repr(data)[2:-1]
        line = f"{time.time():.3f} {rep}"
        with open(log, "a") as f:
            f.write(line + "\n")
        sys.stdout.write(rep[:200] + "\r\n")
        sys.stdout.flush()
        if data in (b"\x03", b"\x1b[99;5u"):
            break
finally:
    sys.stdout.write("".join(off))
    sys.stdout.flush()
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
