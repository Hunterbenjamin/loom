// xterm.js 6 over node-pty, with the addons and the kitty key shim spike 03 specified.
// Terminals are for humans: nothing here parses output or decides anything.

import type { Task } from "@loom/core";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { kittyEncode } from "./kitty.js";

const THEMES = {
  dark: { background: "#0b0c0e", foreground: "#d8dbde", cursor: "#7aa2f7" },
  light: { background: "#ffffff", foreground: "#1b1e23", cursor: "#3563c7" },
};

export function TerminalTab({
  task,
  theme,
}: {
  task: Task;
  theme: "dark" | "light";
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("starting...");
  const [command, setCommand] = useState("");

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const id = `${task.id}:terminal`;
    const terminal = new Terminal({
      fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      allowProposedApi: true,
      // Option+drag selects locally; a plain drag is a mouse event for the pane host (spike 03).
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: THEMES[theme],
      scrollback: 0,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new UnicodeGraphemesAddon());
    terminal.unicode.activeVersion = "15-graphemes";
    terminal.open(element);
    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // Software rendering still works; only throughput suffers.
    }
    fit.fit();
    window.loom.term = terminal;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const encoded = kittyEncode(event);
      if (!encoded) return true;
      window.loomTerminal.write(id, encoded);
      return false;
    });

    terminal.onData((data) => window.loomTerminal.write(id, data));
    let spawned = false;
    let sentCols = terminal.cols;
    let sentRows = terminal.rows;
    const syncSize = () => {
      const { cols, rows } = terminal;
      if (!spawned || (cols === sentCols && rows === sentRows)) return;
      sentCols = cols;
      sentRows = rows;
      window.loomTerminal.resize(id, cols, rows);
    };
    terminal.onResize(syncSize);
    window.loomTerminal.onData(id, (data) => terminal.write(data));
    window.loomTerminal.onExit(id, ({ exitCode }) => {
      // Exit 1 from an attach means "already attached" or "taken over"; both are states the
      // human resolves, never something Loom retries on its own (spike 03).
      setStatus(
        exitCode === 0
          ? "detached"
          : `exited ${exitCode} - reattach from the toolbar`,
      );
    });

    let disposed = false;
    void window.loomTerminal
      .spawn({ id, cols: terminal.cols, rows: terminal.rows, label: task.id })
      .then((result) => {
        if (disposed) return;
        spawned = true;
        // A layout resize can land while the spawn request is in flight.
        syncSize();
        setCommand(result.command);
        setStatus(`pid ${result.pid}`);
        terminal.focus();
      })
      .catch((error: unknown) => {
        if (!disposed) setStatus(String(error));
      });

    // Resize on panel resize only, debounced: the attached client owns the pane size for
    // every other viewer, and that size sticks after detach (spike 03).
    let timer: number | undefined;
    let width = element.clientWidth;
    let height = element.clientHeight;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const next = entry.contentRect;
      if (next.width === width && next.height === height) return;
      width = next.width;
      height = next.height;
      window.clearTimeout(timer);
      if (width <= 0 || height <= 0) return;
      timer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          // The panel can be detached mid-animation.
        }
      }, 80);
    });
    observer.observe(element);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      observer.disconnect();
      window.loom.term = null;
      window.loomTerminal.off(id);
      void window.loomTerminal.kill(id);
      terminal.dispose();
    };
  }, [task.id, theme]);

  return (
    <div className="terminal-wrap">
      <div className="terminal-bar">
        <span className="mono terminal-command" title={command}>
          {command || "..."}
        </span>
        <span>{status}</span>
      </div>
      <div className="terminal-host" data-testid="terminal">
        <div className="terminal-viewport" ref={host} />
      </div>
    </div>
  );
}
