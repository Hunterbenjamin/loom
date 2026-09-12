// xterm.js 6 over node-pty, with the addons and the kitty key shim spike 03 specified.
// Terminals are for humans: nothing here parses output or decides anything.

import type { RunId, Task } from "@loom/core";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { memo, useEffect, useRef, useState } from "react";
import { shallowArray, useStore } from "../store/react.js";
import { terminalsForTask } from "../store/selectors.js";
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
  const live = useStore((s) => s.live);
  const runs = useStore(
    (s) => terminalsForTask(s.snapshot, task),
    shallowArray,
  );
  const [activeRunId, setActiveRunId] = useState<RunId | null>(null);
  const selectedRunId = runs.some((run) => run.id === activeRunId)
    ? activeRunId
    : (runs[0]?.id ?? null);

  useEffect(() => {
    if (activeRunId !== selectedRunId) setActiveRunId(selectedRunId);
  }, [activeRunId, selectedRunId]);

  if (runs.length === 0) {
    return (
      <div className="terminal-empty faint">
        {task.stage === "done" || task.stage === "canceled"
          ? "Task is done"
          : "No agent is running for this task"}
      </div>
    );
  }

  return (
    <div className="terminal-tab">
      {runs.length > 1 ? (
        <div className="terminal-tabs" role="tablist" aria-label="Task runs">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              role="tab"
              aria-controls={`terminal-pane-${run.id}`}
              aria-selected={run.id === selectedRunId}
              onClick={() => setActiveRunId(run.id)}
            >
              {run.role} · {run.provider}
            </button>
          ))}
        </div>
      ) : null}
      <div className="terminal-panes">
        {runs.map((run) => (
          <div
            className="terminal-pane"
            id={`terminal-pane-${run.id}`}
            key={run.id}
            role="tabpanel"
            hidden={run.id !== selectedRunId}
          >
            <TerminalSession
              label={`${task.id} · ${run.role}`}
              runId={run.id}
              theme={theme}
              live={live}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The shared attach client for task runs and the instance Lead. Unmount only detaches. */
export const TerminalSession = memo(function TerminalSession({
  panelId,
  shellKey,
  shellName,
  pane,
  onKey,
  label,
  runId = null,
  lead = false,
  operator = false,
  theme,
  live,
}: {
  panelId?: string;
  shellKey?: string;
  shellName?: string;
  pane?: import("@loom/protocol").PaneIdentity;
  onKey?: (event: KeyboardEvent, literal: () => void) => boolean;
  label: string;
  runId?: RunId | null;
  lead?: boolean;
  operator?: boolean;
  theme: "dark" | "light";
  live: boolean;
}) {
  if (panelId && window.loom) {
    window.loom.terminalRenders ??= {};
    window.loom.terminalRenders[panelId] =
      (window.loom.terminalRenders[panelId] ?? 0) + 1;
  }
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("starting...");
  const [command, setCommand] = useState("");

  const settings = useRef({ label, theme, onKey });
  settings.current = { label, theme, onKey };
  const instance = useRef<Terminal | null>(null);
  useEffect(() => {
    if (instance.current) instance.current.options.theme = THEMES[theme];
  }, [theme]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (live && !runId && !lead && !operator && !pane && !shellKey) {
      setStatus("Select a run to attach");
      return;
    }
    const id = `${panelId ?? "terminal"}:${crypto.randomUUID()}`;
    const terminal = new Terminal({
      fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      allowProposedApi: true,
      // Option+drag selects locally; a plain drag is a mouse event for the pane host (spike 03).
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: THEMES[settings.current.theme],
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
    instance.current = terminal;
    window.loom.term = terminal;
    window.loom.terms ??= {};
    window.loom.terms[panelId ?? id] = terminal;

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        settings.current.onKey?.(event, () =>
          window.loomTerminal.write(id, "\x01"),
        )
      )
        return false;
      if (event.defaultPrevented) return false;
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
      .spawn({
        id,
        cols: terminal.cols,
        rows: terminal.rows,
        label: settings.current.label,
        pane,
        shellKey,
        shellName,
        lead,
        operator,
        runId,
      })
      .then((result) => {
        if (disposed) {
          void window.loomTerminal.kill(id);
          return;
        }
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
      if (window.loom.term === terminal) window.loom.term = null;
      delete window.loom.terms?.[panelId ?? id];
      instance.current = null;
      window.loomTerminal.off(id);
      void window.loomTerminal.kill(id);
      terminal.dispose();
    };
  }, [panelId, pane, live, runId, lead, operator, shellKey, shellName]);

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
});
