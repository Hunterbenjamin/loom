# Spike 03: Embedded terminal

**Agent:** claude · **Timebox:** about 3 hours · **Depends on:** nothing. Read `spikes/README.md` first.

## Why

Loom's issue page shows the agent's real terminal. Herdr's socket API doesn't stream raw terminal output, so
the plan is to run `herdr agent attach <name>` inside a PTY and render it in the app. We need to know two things:
whether that feels native, and which renderer to use.

## Setup

- **Test app:** a minimal Electron app in this directory, with node-pty in the main process. The renderer can be
  switched between xterm.js 6 (with the WebGL addon) and ghostty-web.
- **Targets:** agents you start yourself, in your own workspace. Start one Claude agent, for example
  `herdr agent start s03-claude --kind claude --pane <pane> -- --model haiku`, and one Codex agent.
  Only attach to agents you started.

## Questions

1. **Attach.**
   - Does `herdr agent attach s03-claude` in the embedded PTY give a working interactive session?
   - What does `--takeover` change?
   - Can the Herdr TUI, open in Ghostty, show the same pane at the same time?
   - What happens when the two clients have different sizes?
2. **Fidelity.** For both renderers, with Claude Code and Codex running, check:
   - colors and box drawing;
   - emoji and CJK character widths;
   - the alternate screen, resizing and scrollback;
   - mouse and scroll wheel;
   - bracketed paste;
   - Shift+Enter and other modified keys;
   - copy/paste and focus.

   Give a checklist table per renderer.
3. **Performance.**
   - Throughput: `yes | head -n 2000000` and a large `cat`.
   - CPU and memory with 1 and with 6 terminals open.
   - How typing latency feels.
4. **Lifecycle.** Closing the embedded terminal must detach, not stop the agent. Quit and relaunch the app,
   then reattach.
5. **Open in Ghostty.** Find a command that reliably opens a new Ghostty window running
   `herdr agent attach <name>` (Ghostty 1.3.1 on macOS), and verify it.

## Deliverable

`FINDINGS.md`, containing:
- the checklist tables and the performance numbers;
- a renderer recommendation;
- how attach and takeover behave;
- the Ghostty command.
