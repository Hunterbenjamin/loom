# Spike 03: Does `herdr agent attach` work in a terminal embedded in Electron (xterm.js vs ghostty-web)?

Versions: herdr 0.9.0 (protocol 22) · Ghostty 1.3.1 (stable) · Claude Code 2.1.268 (`--model haiku`) ·
codex-cli 0.154.0 (`-c model="gpt-5.3-codex-spark"`) · Electron 44.3.0 (Chromium 152.0.7977.78, Node 24.20.0) ·
node-pty 1.1.0 · @xterm/xterm 6.0.0 + addon-webgl 0.19.0, addon-fit 0.11.0, addon-unicode11 0.9.0,
addon-unicode-graphemes 0.4.0 · ghostty-web 0.4.0 · Playwright 1.63.0 · Node 23.6.0 (driver) · Python 3.13.1 ·
macOS 26.2 (25C56) on an Apple M3, 8 cores, 8 GB.

All experiments ran against a private Herdr session (`herdr --session loom-s03`, its own server and socket), in a
throwaway git repo under `$TMPDIR/loom-spike-03-embedded-terminal/work`. Targets: `s03-claude` (Claude, pane
`w1:p1`), `s03-codex` (Codex, `w1:p2`), and pseudo-agents `s03-keys`, `s03-x4..6` (plain shell panes registered with
`herdr pane report-agent` + `herdr agent rename`, so they can be attached to). No shared daemon, main Herdr server or
global config was touched.

## Summary

| Question | Result | One-line answer |
|---|---|---|
| 1a. Attach in an embedded PTY | works | `herdr agent attach` under node-pty renders Claude and Codex and takes input in both renderers; it is a full-screen client (alt screen, mouse, kitty keys). |
| 1b. `--takeover` | works | Only one attach client per terminal. A second plain attach is refused; `--takeover` evicts the current client (it exits 1) and resizes the pane to the new client. |
| 1c. Herdr TUI at the same time | works with caveats | The TUI is not an attach client, so both run at once and the TUI stays live. But the pane takes the attach client's size, so the TUI shows only a cropped top-left part of it. |
| 1d. Different client sizes | works with caveats | The attach client's size wins: the pane is resized to it, and keeps that size after detach. |
| 2. Fidelity, xterm.js 6 + WebGL | works with caveats | Colors, box drawing, CJK, mouse, wheel-scrollback, bracketed paste, resize all fine. Shift+Enter needs a 10-line key shim (verified); ZWJ emoji and flags need `addon-unicode-graphemes` (verified). |
| 2. Fidelity, ghostty-web 0.4.0 | doesn't | Best Unicode rendering out of the box, but no mouse reporting, the wheel turns into ↑ keys (history recall), Shift+Tab and Option are broken, Cmd+V paste isn't bracketed, `insertText` is ignored, and its render loop burns 17–37 % CPU while idle. |
| 3. Performance | works | Herdr is the bottleneck, not the renderer. Floods through an attached view finish as fast as with no client (only KBs of frames arrive), the page holds 120 fps, and key-to-echo p50 is about 7 ms through Herdr. xterm idles at about 1.5 % CPU with 6 terminals; ghostty-web burns 17–37 %. |
| 4. Lifecycle | works | Closing a terminal sends SIGHUP; the attach exits 0 and the agent keeps running. After quitting, or even SIGKILLing the app, no attach process is left, and the relaunched app reattaches without `--takeover`. |
| 5. Open in Ghostty | works | `osascript … new window with configuration` (command = `herdr agent attach <name>`) opens a window in the running Ghostty; `open -na Ghostty.app --args -e …` also works but starts a second Ghostty process. |

**Renderer recommendation: xterm.js 6 + WebGL**, with (a) a custom key handler that sends kitty/CSI-u for
Shift+Enter (and the other modified keys Herdr asks for), (b) `@xterm/addon-unicode-graphemes`, and (c)
`macOptionIsMeta` + `macOptionClickForcesSelection`. Re-evaluate ghostty-web when it has mouse reporting and a
kitty-aware key encoder; its Unicode handling is already better.

## Evidence

Scripts are in this directory: `probe-attach.mjs` and `probe-two-clients.mjs` (headless node-pty probes),
`main.cjs`/`preload.cjs`/`renderer.mjs`/`index.html` (the test app), `drive.mjs` + `scenarios*.mjs` (Playwright
driver), `keylog.py` (prints the raw bytes that reach the program inside the pane), `testpattern.sh`.
Screenshots referenced below are in `evidence/`.

### 1. Attach

**What attach emits** (`node probe-attach.mjs s03-claude`, run 3× for Claude/Codex/takeover, same result each time,
trimmed):

```
"altScreen": true, "mouseAny_1003": true, "mouseSgr_1006": true, "bracketedPaste_2004": true,
"focusEvents_1004": false, "kittyKeyboardPush": ["[>5u"], "modifyOtherKeys": ["[>4;2m"],   # MOK only for Claude
"syncOutput_2026": true
privateModes: ?1049h ?1000h ?1002h ?1003h ?1015h ?1006h ?2004h ?7l ?2026h/l ?25l/h
```

So attach is a tmux-style client: Herdr re-renders the pane on the alternate screen of *our* terminal, turns on
all-motion SGR mouse, and asks for kitty keyboard flags 5 (disambiguate + report alternate keys). Herdr then
re-encodes input for whatever the program in the pane asked for (evidence in section 2: motion events are dropped for
an app that only asked for `?1000`). Attaching to a plain shell pane fails:
`{"error":{"code":"agent_not_found","message":"agent target w1:p3 not found"}}`; `herdr pane report-agent` +
`herdr agent rename` makes any pane attachable.

**Embedded** (`node drive.mjs <renderer> smoke <agent>`, xterm→Claude and ghostty→Codex, 1× each, plus every later
scenario attaches again): both show the agent UI (`evidence/xterm-smoke-s03-claude.png`,
`evidence/ghostty-smoke-s03-codex.png`), typed `hello` appears in the prompt, and closing sends SIGHUP:
`"closeExit": {"exitCode": 0, "signal": 0}`; `herdr agent list` afterwards still shows both agents `idle`.

**Two clients / takeover** (`node probe-two-clients.mjs s03-claude --a 100x30 --b 70x20 [--takeover-b]`, 1× each,
trimmed):

```
### normal B
A attached 100x30            A bytes=7290 exited=null  | viewport_rows=30
B attached 70x20             ... B exited={"exitCode":1} | viewport_rows=30
B tail: "herdr: server shut down: terminal attach failed: terminal term_65b3… already has an attached client; retry with --takeover"
### takeover B
B attached 70x20 --takeover  A exited={"exitCode":1} | B bytes=3713 exited=null | viewport_rows=20
  A received 0 bytes, B received 103 bytes after B typed
A closed                     ... viewport_rows=20
A tail: "herdr: server shut down: terminal attach taken over"
```

The same holds across apps: with Ghostty holding the attachment, an embedded/probe attach is refused with the same
message, and `--takeover` from the probe evicted Ghostty's client (section 5).

**Sizes.** The pane follows the attached client, not the Herdr layout: layout rect `60x20` but
`viewport_rows=52` while a 183x52 client was attached; resizing the Electron window to 900x560 took Claude's pane from
`183x52 pane rows=52` to `116x31 pane rows=31` (both renderers; Codex identical). After detach the pane keeps the
last client's size (`viewport_rows=28` after a 90x28 takeover probe had detached).

**Herdr TUI at the same time.** `node drive.mjs xterm tui` (1×) runs a real Herdr TUI client (`herdr --session loom-s03`) in one embedded
terminal and `herdr agent attach s03-claude` in another (`evidence/xterm-tui-plus-attach.png`):

```
"tuiStart": {"exited": null, "firstLines": ["spaces  │ 1 + ", " ○ s03 ││ … "]}
"attachOk": true
"withBoth": {"tuiClient": "183x26", "attachClient": "183x24",
             "pane": {"viewport_rows": 24}, "rect": {"height": 13, "width": 40}}
"tuiShowsTyping": false, "exitedAfterTyping": {"tui": null, "attach": null}
"afterDetach": {"pane": {"viewport_rows": 24}, "tuiExited": null}
```

Both clients stay connected: the TUI isn't an "attached client", so attach doesn't refuse it and doesn't evict it.
The pane is sized for the attach client (183x24), but the TUI draws it in its 40x13 layout box, so the TUI shows
only the top-left 40x13 of the pane. Text typed at Claude's prompt (bottom rows) was not visible in the TUI
(`tuiShowsTyping: false`), while the conversation above it was. After the embedded client detached the pane stayed at
24 rows. The earlier attempt without scrubbing the environment failed. A TUI started with `HERDR_ENV=1` inherited
(the driver runs inside a Herdr pane) exits 1 with `error: nested herdr is disabled by default. see configuration
if you want to enable it.` It was run inside the Electron app rather than a Ghostty
window so it could be screenshotted; the TUI is the same client either way.

### 2. Fidelity

Method: `node drive.mjs <renderer> keys` attaches to `s03-keys`, where `keylog.py --paste --mouse --kitty` runs,
and records what the renderer sent (`term.onData`) and what reached the program (`keylog.txt`). `agents` drives Claude
and Codex. `pattern` prints `testpattern.sh` through Herdr and in a local PTY side by side. `shiftenter` types slowly.
Each ran once per renderer; `shiftenter` ran twice per renderer, without and with the fix.

**Checklist: xterm.js 6.0.0 + WebGL addon**

| Check | Result | Evidence |
|---|---|---|
| Colors (16/256/truecolor), SGR attrs | ✅ | `evidence/xterm-pattern.png`, identical through Herdr and local; curly underline drawn straight |
| Box drawing, blocks, braille | ✅ | same screenshot |
| CJK, Hangul, emoji widths | ✅ | right-hand `|` aligned; cursor after `宽字符😀x` in Claude's prompt at col 11 = 2+6+2+1 |
| ZWJ sequences, flags, VS16 | ⚠️ | with `unicode11`: family shows 1 person, flag shows "JP" letters. With `@xterm/addon-unicode-graphemes` (`activeVersion: "15-graphemes"`) all three render as single glyphs and stay aligned (`evidence/xterm-graphemes-pattern.png`) ✅ |
| Alternate screen | ✅ | attach always runs on the alt screen (`bufferType: "alternate"`); Claude/Codex render correctly inside it |
| Resize | ✅ | 183x52 → 116x31, pane follows, agents reflow |
| Scrollback | ✅ via Herdr | wheel sends `\e[<64;…M`; Herdr scrolls the pane's history (`351 \| 352` → `336 \| 337`). xterm's own scrollback is unused (alt screen). |
| Mouse | ✅ | click sent `\e[<35;11;3M \e[<0;11;3M \e[<0;11;3m`; app (mode 1000) received only `\e[<0;11;3M\e[<0;11;3m` |
| Bracketed paste | ✅ | real paste event and `term.paste()` both arrive as `\e[200~p1\rp2\e[201~` |
| Shift+Enter | ❌ native / ✅ with shim | sends `\r` → Claude and Codex **submit** (`agentStatus: "working"`). With the `?keyfix=1` handler: sends `\e[13;2u`, app receives `\e[13;2u`, both agents insert a newline and stay idle |
| Other modified keys | ⚠️ | ✅ Alt+Enter `\e\r`, Shift+Tab `\e[Z`, Alt+← `\e[1;3D`, Option-as-Meta `\eb`, Ctrl+J `\n`; ❌ Ctrl+Enter = `\r` (needs the same shim) |
| Text input (`insertText`, IME commit) | ✅ | `insertText('宽😀')` arrived as UTF-8; IME composition 'かん' → commit '漢' sent `"漢"` (nothing during composition) |
| Copy | ⚠️ | plain drag goes to Herdr as mouse events (no local selection, no OSC 52 seen); **Option+drag** selects locally (`" Code v2.1.268"`) |
| Focus | ✅ | with two terminals, keys only reach the focused one (`typed while other terminal focused: received []`) |

**Checklist: ghostty-web 0.4.0** (canvas renderer, Ghostty VT in wasm)

| Check | Result | Evidence |
|---|---|---|
| Colors, SGR attrs | ✅ | `evidence/ghostty-pattern.png` |
| Box drawing, blocks, braille | ✅ | same |
| CJK, Hangul, emoji widths | ✅ | aligned |
| ZWJ sequences, flags, VS16 | ✅ | family, 🇯🇵 and ❤️ all render as single glyphs and stay aligned, through Herdr and local |
| Alternate screen | ✅ | |
| Resize | ✅ | 171x52 → 109x31, pane follows |
| Scrollback | ❌ | wheel over the attach sends `\e[A` ×5 (alternate-scroll); in a shell it recalled history, in Claude/Codex it would walk prompt history. Herdr's scrollback is unreachable. |
| Mouse | ❌ | click sent nothing (`sent: []`); no mouse reporting at all |
| Bracketed paste | ❌ | a real paste event sends `p1\np2` **without** `\e[200~`; only the `term.paste()` API brackets |
| Shift+Enter | ❌ native / ✅ with shim (the same handler: sends `\e[13;2u`, both agents insert a newline and stay idle) | sends `\r` → submits |
| Other modified keys | ❌ | Shift+Tab sends `\t` (breaks Claude's mode cycling), Alt+b sends `b` (no Option-as-Meta), Ctrl+Enter `\e[27;5;13~` |
| Text input | ⚠️ | IME composition + commit works (`Input.imeSetComposition` 'かん' → commit '漢' sent `"漢"`), but a bare `insertText('宽😀')` (emoji picker, dictation, some input methods) sent nothing |
| Copy | ⚠️ | drag always selects locally (works), because it never reports the mouse |
| Focus | ✅ | keys only reach the focused terminal |

For comparison, **native Ghostty 1.3.1** attached to the same key logger (AppleScript `send key … to t`) delivers
exactly what Herdr asked for, so Herdr passes kitty encoding through to the program:

```
Shift+Enter   \x1b[13;2u        Enter        \r
Shift+Tab     \x1b[9;2u         Ctrl+Enter   \x1b[13;5u
Option+Enter  \x1b[13;3u        paste        \x1b[200~x1\nx2\x1b[201~
```

### 3. Performance

Method: `node drive.mjs <renderer> perf 3` (local floods, latency) and `perf 3 herdr` (through Herdr, rerun
after fixing a timing bug in the first version). Each number is one run; 3 runs per cell. The window was 1400x900
(about 180x52 cells), on a 120 Hz display.

- **Local**: the command runs in a PTY owned by the app. The time is from spawn until the last byte is parsed.
- **Via Herdr**: `herdr pane run w1:p3 '<cmd>; echo <marker>'`, timed until the marker shows up in the embedded
  attach terminal.
- **No client**: the same command with nothing attached, timed with `herdr pane wait-output`.

| Throughput | xterm.js 6 + WebGL | ghostty-web 0.4.0 |
|---|---|---|
| local `yes \| head -n 2000000` (6.0 MB incl. CR) | 1034 / 951 / 950 ms (≈6.3 MB/s), 110–120 fps, max frame gap 22–100 ms | 1120 / 944 / 1001 ms (≈6.0 MB/s), 101–105 fps, max gap 18–26 ms |
| local `cat` 30.7 MB file (33.7 MB incl. CR) | 1196 / 1171 / 1183 ms (≈28.5 MB/s), 113–115 fps, max gap 30–39 ms | 601 / 591 / 845 ms (40–57 MB/s), 89–92 fps, max gap 41–107 ms |
| via Herdr, `yes \| head -n 2000000` | 1072 / 1052 / 1059 ms; 1.5–6.8 KB reached the client; 120 fps | 1487 / 1360 / 1375 ms; 1.9–3.0 KB; 120 fps |
| Herdr, no client | 1051 / 1046 / 1051 ms | 1266 / 1365 / 1448 ms |
| via Herdr, `cat` 30.7 MB | 532 / 515 / 536 ms; ≈25 KB to the client; 120 fps | 621 / 620 / 736 ms; ≈30 KB; 120 fps |
| Herdr, no client | 537 / 527 / 525 ms | 735 / 842 / 535 ms |

Through Herdr the embedded client costs nothing measurable. Herdr parses the flood itself and sends the client only
screen frames (a few KB), so flood times match the no-client baseline and the page keeps 120 fps. Local throughput
(which only matters for non-Herdr terminals) is bounded by PTY + IPC for short lines. For long lines ghostty-web
parses about 2× faster but drops frames (100 ms gaps); xterm keeps rendering smoothly.

Typing latency, measured from `keydown` to the first parsed output that moves the cursor. 30 keystrokes 80 ms apart,
typed with Playwright through the DOM; p50 / p95 / max:

| Latency | xterm.js 6 + WebGL | ghostty-web 0.4.0 |
|---|---|---|
| local `cat` | 5.2 / 11.6 / 11.9 ms | 10.3 / 13.8 / 14.5 ms |
| through Herdr to `cat` | 6.6 / 10.9 / 15.0 ms | 10.0 / 15.3 / 15.8 ms |
| through Herdr to Claude's prompt | 24.5 / 28.1 / 82.9 ms | 28.3 / 35.2 / 36.2 ms |

Herdr adds about 1–2 ms. The ~20 ms more at Claude's prompt is most likely Claude Code redrawing its input box, which a native
terminal would see too (not measured in Ghostty). ghostty-web is about 5 ms slower, probably because its write
callback waits for its render loop. At these numbers typing should feel native. They are measured, not felt: an agent drove the
test, so "feel" wasn't judged by a human.

CPU and memory: `node drive.mjs <renderer> load`, run 2× per renderer. Each sample is an 8 s window with agents attached
(Claude, Codex and four shell panes). CPU is from `ps` CPU time, as % of one core. Electron's own
`getAppMetrics().percentCPUUsage` under-reports about 8× (for example 1.9 % against 15.1 % by `ps`), so it isn't used.
Memory is the sum of `workingSetSize` over Electron's Browser, GPU, Utility and Tab processes, as a range over the
two runs. Numbers are from the second run unless given as a range.

| CPU / memory | xterm.js 6 + WebGL | ghostty-web 0.4.0 |
|---|---|---|
| 1 terminal, Claude idle | Electron **1.3 %**, 133–274 MB · attach client 0.1 %, 8 MB · Herdr 0.3 % | Electron **17 %**, 176–179 MB · attach 0.2 %, 7 MB |
| 1 terminal, 50 lines/s | 9.4 %, 165–248 MB · Herdr 5.2 % | 57 %, 236–244 MB · Herdr 4.8 % |
| 6 terminals, idle | **1.6 %**, 157–289 MB · 6 attach clients 0.5 %, 50–58 MB total | **37 %**, 209–213 MB · attach 0.9 %, 52–55 MB |
| 6 terminals, 4 × 50 lines/s | 15.1 %, 167–283 MB · Herdr 8.1 % | 55 %, 205–240 MB · Herdr 7.9 % |
| 6 terminals, 1 × `yes` flood | 0.3 %, 138 MB · Herdr **111 %** | 18 %, 190 MB · Herdr **106 %** |

- xterm idles at about 1.5 % CPU whether 1 or 6 terminals are open. ghostty-web's canvas render loop redraws every
  frame even when nothing changes: 17 % with one idle terminal and 37 % with six, on a 120 Hz display. That's a
  battery problem on a laptop.
- Memory is mostly Electron itself (130–290 MB, varying between runs on this 8 GB machine). Each extra terminal
  costs a few MB in the renderer plus about 8 MB for its `herdr agent attach` process.
- Herdr carries the load, not the renderer. During a `yes` flood the Herdr server runs at about 110 % CPU and sends
  the client almost nothing. The embedded view barely moves until the flood ends, which matches the few KB per flood
  in the throughput table.
- Caveat: the test app disables Chromium's background throttling (see "Testing" below), so a real app may idle
  lower while hidden.

### 4. Lifecycle

`node drive.mjs <renderer> lifecycle` (1× per renderer, identical results; xterm shown, trimmed):

```
firstLaunch:        s03-claude ok in 462ms, s03-codex ok in 53ms
attachProcsWhileOpen: 47933 herdr agent attach s03-claude / 47944 herdr agent attach s03-codex
closeOne:           exit {"exitCode":0,"signal":0}; agents s03-claude:idle s03-codex:idle …; attachProcs: 47944 (codex only)
afterQuit:          attachProcs none, electronProcs 0, agents all idle
relaunch:           s03-claude ok in 353ms, s03-codex ok in 327ms          # plain attach, no --takeover
afterSigkill:       attachProcs none, electronProcs 0, agents all idle     # kill -9 of the Electron main process
relaunchAfterCrash: s03-claude ok in 357ms, s03-codex ok in 65ms
```

Closing a panel sends SIGHUP (`pty.kill('SIGHUP')`), the same as closing a terminal window. On quit the main
process SIGHUPs every PTY in `before-quit`. On SIGKILL nothing runs, but the kernel closes the PTY master and the
attach clients get SIGHUP anyway. In every case Herdr released the attachment at once, so the next attach succeeded
without `--takeover`. The "ok in" times include Herdr sending the first full frame.

### 5. Open in Ghostty

Verified with Ghostty 1.3.1 (run from a shell; each variant 1×, plus 1× more for the key test):

```sh
osascript -e 'tell application "Ghostty"' \
  -e 'set cfg to new surface configuration' \
  -e 'set command of cfg to "/Users/<you>/.local/bin/herdr agent attach s03-codex"' \
  -e 'set w to new window with configuration cfg' \
  -e 'return id of w' -e 'end tell'
```

```
window id: tab-group-b804c69e0
21053 /usr/bin/login -flp <user> /bin/bash --noprofile --norc -c exec -l /Users/<you>/.local/bin/herdr --session loom-s03 agent attach s03-codex
--- second plain attach (should be refused if Ghostty holds it):
terminal attach failed: terminal term_65b322eff822f2 already has an attached client; retry with --takeover
```

- Use an absolute `herdr` path: the command runs under `login … bash --noprofile --norc`, so the user's `PATH` isn't
  loaded.
- The returned window id can be used later (`close window (first window whose id is …)`). When the attach exits (for example because it was taken over), the window **stays open** showing the exited process, with or without `set wait after command of cfg to false` (tested both, 1× each). Close it with `tell application "Ghostty" to close window (first window whose id is "<id>")`.
- Alternative without AppleScript: `open -na Ghostty.app --args --quit-after-last-window-closed=true -e /abs/herdr agent attach <name>`.
  Verified: a second `ghostty` process appears (pids `25739` → `25561 25739`), and when the attach is taken over the
  window and that process go away (`25739` only). Downside: one extra Ghostty process (and Dock icon) per window.
- `ghostty +new-window` prints `+new-window is not supported on this platform.` on macOS.

## Implications for Loom

Proposed changes to `docs/architecture.md` (not made in this PR; for the human to accept):

1. **Agent integration → Attach (Claude and Codex rows):** "Embedded view = node-pty in the main process running
   `herdr agent attach <name>`, rendered with xterm.js. Attach is **exclusive per terminal**: only one attach client
   (Loom's panel, a Ghostty window) at a time." Drop the *(spike 03)* marker.
2. **Stack → Terminal:** `xterm.js 6 + @xterm/addon-webgl + addon-fit + addon-unicode-graphemes, with node-pty`.
   ghostty-web is not ready (section 2).
3. **Out of scope** already says "no custom terminal emulator"; add one exception we now need: a small **kitty
   keyboard shim** in the renderer. Herdr asks the client for kitty flags 5 and passes CSI-u through to the agent,
   but xterm.js 6.0 ignores the request, so Shift+Enter (and Ctrl+Enter, Ctrl+Tab…) must be encoded by Loom
   (`\e[13;2u` etc.). Verified for Shift+Enter with Claude and Codex. Drop the shim once xterm.js ships kitty
   keyboard support.

Adapter design (`packages/adapters/herdr` + `apps/desktop`):

- **Takeover is a user action, never automatic.** Opening a task's terminal does a plain attach. If it exits 1 with
  `already has an attached client`, show "Open elsewhere (e.g. Ghostty) · Take over here". When Loom's own client
  exits 1 with `terminal attach taken over`, show "Taken over · Reattach" instead of an error. Both are plain-text
  messages on the PTY, so match them by exit code first and only use the text as a hint.
- **The attached client owns the pane size, and the size sticks after detach.** A small embedded panel shrinks the
  agent's pane for every viewer. Give the embedded terminal a sensible minimum (for example 100 cols), and resize on
  panel resize only (debounced).
- **Scrollback lives in Herdr**, not in xterm.js (attach runs on the alternate screen). Wheel events must reach Herdr
  as SGR mouse (xterm does this). History/search features should read provider transcripts (principle 4), not the
  terminal buffer.
- **Copy:** plain drag is a mouse event for Herdr, and no OSC 52 was seen, so nothing reaches the clipboard. Set
  `macOptionClickForcesSelection` (Option+drag selects locally) and add a visible "copy" affordance or hint.
- **Closing a panel = SIGHUP to the attach client.** It exits 0 and the agent keeps running. Quitting or crashing the app leaves no stale attachment, so reattaching on launch never needs `--takeover`. Which panels were open is UI state and can be dropped (principle 5).
- **Environment hygiene.** Programs in panes inherit the Herdr *server's* environment. Starting a Herdr server from
  inside a Claude Code session leaked `CLAUDE_CODE_CHILD_SESSION` into the Claude agents, which then showed
  "⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker". That would break principle 7
  (resumable sessions). The coordinator must start Herdr servers and agents with a scrubbed environment (drop
  `CLAUDE_CODE_*`, `HERDR_*` markers). Likewise, a Herdr TUI started with an inherited `HERDR_ENV=1` exits 1: `error: nested herdr is disabled by default`.
- **Floods:** while a pane floods output, its attached view is almost static, because Herdr is saturated and
  sends few frames. That's fine for agents, but don't sell the embedded view as a log tail.
- **node-pty packaging:** the N-API prebuilds load in Electron 44 without a rebuild, but npm drops the exec bit on
  `prebuilds/darwin-*/spawn-helper` (`posix_spawnp failed`). Add a postinstall `chmod +x`.
- **Open in Ghostty:** use the AppleScript command in section 5 and store the returned window id, so Loom can focus
  that window instead of opening a second one (and a second attach would be refused anyway).
- **Testing:** Playwright's `_electron` + `window.<hook>` drives the real renderer well. Launch Electron with
  `disable-backgrounding-occluded-windows` (and `backgroundThrottling: false`), or a covered window stops
  `requestAnimationFrame` and tests hang.

## Open questions

- **Who holds the attachment?** `herdr pane get` / `agent get` don't say whether a client is attached or which one.
  Loom can only find out by trying. Is there (or could there be) a field or event for it?
- **Herdr copy mode.** What does Herdr do with a plain drag in an attach client: does it select and copy anywhere?
  No OSC 52 reached the client in these tests.
- **macOS Automation prompt.** When Loom itself (not a terminal) runs `osascript` to control Ghostty, macOS will ask
  once for Automation permission. That couldn't be tested from inside Ghostty. `open -na` avoids it.
- **The AppleScript window doesn't close when the attach exits.** Tested with exit code 1 (takeover) only. Does a normal exit 0 close it? If not, Loom should close the window it opened when it takes the attach back.
- **xterm.js kitty keyboard support.** 6.1 betas are out; check whether they honor `CSI > flags u` before writing a
  full shim.
- **Sizing policy with several viewers.** When the embedded client and the TUI disagree, the TUI shows a crop and nobody is told. Does Herdr plan a "smallest client wins" or "resize to TUI on detach" mode? Until then Loom should avoid leaving the pane at a tiny size.

## How to rerun

```sh
cd spikes/03-embedded-terminal
npm install
chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper   # npm drops the exec bit → "posix_spawnp failed"
node node_modules/electron/install.js                              # Electron 44 downloads its binary lazily

# private Herdr session + targets
herdr --session loom-s03 server &
export HERDR_SOCKET_PATH=$HOME/.config/herdr/sessions/loom-s03/herdr.sock
W=$TMPDIR/loom-spike-03-embedded-terminal/work; mkdir -p $W; git -C $W init
herdr workspace create --cwd $W --label s03 --no-focus          # → w1:p1
herdr pane split w1:p1 --direction right --cwd $W --no-focus    # → w1:p2
herdr pane split w1:p1 --direction down --cwd $W --no-focus     # → w1:p3 (+ p4..p6 the same way)
herdr agent start s03-claude --kind claude --pane w1:p1 -- --model haiku        # answer the trust prompt
herdr agent start s03-codex --kind codex --pane w1:p2 -- -c 'model="gpt-5.3-codex-spark"'
herdr pane report-agent w1:p3 --source s03-spike --agent keylog --state idle && herdr agent rename w1:p3 s03-keys
# (same for p4..p6 as s03-x4..s03-x6)
seq 1 3000000 > $TMPDIR/loom-spike-03-embedded-terminal/big.txt

node probe-attach.mjs s03-claude [--takeover]
node probe-two-clients.mjs s03-claude --a 100x30 --b 70x20 [--takeover-b]
for r in xterm ghostty; do
  node drive.mjs $r smoke s03-claude
  node drive.mjs $r keys
  node drive.mjs $r agents
  node drive.mjs $r pattern
  node drive.mjs $r shiftenter nofix; node drive.mjs $r shiftenter fix
  node drive.mjs $r perf 3; node drive.mjs $r load; node drive.mjs $r lifecycle
done
node drive.mjs xterm tui
S03_QUERY=graphemes=1 S03_TAG=-graphemes node drive.mjs xterm pattern
npm start   # interactive: S03_RENDERER=ghostty npm start
```

Harness notes: two early runs of `ghostty shiftenter nofix` hung inside `open()` and had to be killed. After adding
the occlusion flags and starting the key logger before launching the app, it ran cleanly (1×, same result as the
`keys` scenario). Codex's paste-burst detection turns a fast `a⏎b` into a newline, so the Shift+Enter tests type
slowly.
