// xterm.js 6 over node-pty, with the addons and the kitty key shim spike 03 specified.
// Terminals are for humans: nothing here parses output or decides anything.

import type { RunId, Task } from "@loom/core";
import type { AckResult } from "@loom/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { shallowArray, useStore, useStoreApi } from "../store/react.js";
import { terminalsForTask } from "../store/selectors.js";
import { kittyEncode } from "./kitty.js";
import { type PaneViewport, terminalCrop } from "./terminal-crop.js";

const THEMES = {
  dark: { background: "#0b0c0e", foreground: "#d8dbde", cursor: "#7aa2f7" },
  light: { background: "#ffffff", foreground: "#1b1e23", cursor: "#3563c7" },
};
export const TerminalHistoryContext = createContext(10_000);

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

  if (runs.length === 0) return <TaskShellTerminal task={task} theme={theme} />;

  return (
    <div className="terminal-tab">
      {runs.length > 1 ? (
        <div className="terminal-tabs" role="tablist" aria-label="Issue runs">
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

function TaskShellTerminal({
  task,
  theme,
}: {
  task: Task;
  theme: "dark" | "light";
}) {
  const store = useStoreApi();
  const live = useStore((s) => s.live);
  const contextKey = useStore((s) =>
    JSON.stringify(
      s.snapshot.runs
        .filter((run) => run.taskId === task.id && !run.endedAt)
        .map((run) => [
          run.id,
          run.pane,
          run.pane &&
            s.panes.find(
              (p) =>
                p.hostGeneration === run.pane?.hostGeneration &&
                p.paneId === run.pane?.paneId,
            )?.dead,
        ]),
    ),
  );
  const [retry, setRetry] = useState(0);
  const [terminal, setTerminal] = useState<Extract<
    AckResult,
    { kind: "task_terminal" }
  > | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-resolve when task/run identity changes or the human retries, without remounting for activity updates.
  useEffect(() => {
    if (!live) return;
    let disposed = false;
    setError("");
    void store
      .command({ kind: "open_task_terminal", taskId: task.id })
      .then((outcome) => {
        if (disposed) return;
        if (!outcome.ok) throw new Error(outcome.error.message);
        if (
          outcome.result.kind !== "task_terminal" ||
          outcome.result.taskId !== task.id
        )
          throw new Error("Issue terminal was not confirmed");
        const next = outcome.result;
        setTerminal((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
      })
      .catch((error: unknown) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [store, task.id, task.stage, task.worktreePath, live, contextKey, retry]);
  const selected = terminal?.taskId === task.id ? terminal : null;
  return (
    <div className="terminal-tab">
      {error ? (
        <div role="alert">
          {error}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry terminal
          </button>
        </div>
      ) : live && !selected ? (
        <p role="status">Opening issue terminal…</p>
      ) : null}
      {selected && (
        <div className="terminal-bar" role="status">
          {selected.source === "agent"
            ? "Agent terminal"
            : selected.source === "worktree"
              ? "Issue worktree"
              : "Project root"}
          {" · "}
          {selected.branch ?? "detached HEAD"}
        </div>
      )}
      {(!live || selected) && (
        <TerminalSession
          key={task.id}
          label={task.id}
          pane={selected?.target}
          theme={theme}
          live={live}
        />
      )}
    </div>
  );
}

/** The shared attach client for task runs and the instance Lead. Unmount only detaches. */
export const TerminalSession = memo(function TerminalSession({
  panelId,
  viewport,
  shellKey,
  shellName,
  pane,
  onKey,
  label,
  runId = null,
  lead,
  operator = false,
  theme,
  live,
}: {
  panelId?: string;
  viewport?: PaneViewport;
  shellKey?: string;
  shellName?: string;
  pane?: import("@loom/protocol").PaneIdentity;
  onKey?: (event: KeyboardEvent, literal: () => void) => boolean;
  label: string;
  runId?: RunId | null;
  lead?: string;
  operator?: boolean;
  theme: "dark" | "light";
  live: boolean;
}) {
  const terminalHistoryLimit = useContext(TerminalHistoryContext);
  if (panelId && window.loom) {
    window.loom.terminalRenders ??= {};
    window.loom.terminalRenders[panelId] =
      (window.loom.terminalRenders[panelId] ?? 0) + 1;
  }
  const host = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(viewport);
  const fitViewport = useRef<(() => void) | null>(null);
  useEffect(() => {
    viewportRef.current = viewport;
    fitViewport.current?.();
  }, [viewport]);
  const [status, setStatus] = useState("starting...");
  const [command, setCommand] = useState("");

  const settings = useRef({ label, theme, onKey });
  settings.current = { label, theme, onKey };
  const instance = useRef<Terminal | null>(null);
  useEffect(() => {
    if (instance.current) instance.current.options.theme = THEMES[theme];
  }, [theme]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: History is captured when this terminal attaches; changing the default must not remount active sessions.
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
      // A plain drag selects locally: the pane host's mouse tracking is intercepted below and
      // only wheel events are forwarded to it.
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: THEMES[settings.current.theme],
      scrollback: terminalHistoryLimit,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new UnicodeGraphemesAddon());
    terminal.unicode.activeVersion = "15-graphemes";
    terminal.open(element);
    // Copy on select, as Ghostty and Herdr do: once the selection settles it is on the
    // clipboard. The selection stays visible; Cmd+V pastes as usual.
    let copyTimer: number | undefined;
    const copyDisposable = terminal.onSelectionChange?.(() => {
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        const selected = terminal.getSelection?.();
        if (selected)
          void navigator.clipboard?.writeText(selected).catch(() => {});
      }, 120);
    });
    // Mouse tracking requested by the pane host (tmux `mouse on`) is intercepted: xterm never
    // enters tracking mode, so a plain drag selects locally, and only wheel events are forwarded
    // to tmux as SGR mouse reports, so scrolling inside panes keeps working.
    let hostWantsMouse = false;
    const MOUSE_MODES = new Set([1000, 1002, 1003, 1005, 1006, 1015]);
    const mouseModeHandler =
      (enable: boolean) => (params: (number | number[])[]) => {
        const flat = params.map((p) => Number(Array.isArray(p) ? p[0] : p));
        if (!flat.every((p) => MOUSE_MODES.has(p))) return false;
        if (flat.some((p) => p === 1000 || p === 1002 || p === 1003))
          hostWantsMouse = enable;
        return true;
      };
    // Taken in the capture phase: xterm's own viewport otherwise turns a wheel in the alternate
    // screen (which tmux always draws in) into arrow keys before this listener runs.
    const onWheel = (event: WheelEvent) => {
      event.stopPropagation();
      event.preventDefault();
      if (!hostWantsMouse) return;
      const screen = element.querySelector<HTMLElement>(".xterm-screen");
      const box = screen?.getBoundingClientRect();
      if (!box?.width || !box.height) return;
      const cell = (fraction: number, count: number) =>
        Math.min(count, Math.max(1, Math.floor(fraction * count) + 1));
      const col = cell((event.clientX - box.left) / box.width, terminal.cols);
      const row = cell((event.clientY - box.top) / box.height, terminal.rows);
      const button = event.deltaY < 0 ? 64 : 65;
      const lines = Math.max(
        1,
        Math.min(10, Math.round(Math.abs(event.deltaY) / 24)),
      );
      for (let i = 0; i < lines; i++)
        window.loomTerminal.write(id, `\x1b[<${button};${col};${row}M`);
    };
    element.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    // A TUI may ask for a blinking cursor (DECSCUSR 1/3/5, or DECSET 12). Keep its cursor
    // shape but never blink: a blinking cursor over a fast-redrawing TUI reads as flicker.
    // (Test doubles of xterm carry no parser.)
    const parser = (terminal as { parser?: typeof terminal.parser }).parser;
    parser?.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      const style = Number(params[0] ?? 0);
      terminal.options.cursorStyle =
        style >= 5 ? "bar" : style >= 3 ? "underline" : "block";
      terminal.options.cursorBlink = false;
      return true;
    });
    const swallowBlink = (params: (number | number[])[]) =>
      params.length === 1 && params[0] === 12;
    const enableMouse = mouseModeHandler(true);
    const disableMouse = mouseModeHandler(false);
    parser?.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => swallowBlink(params) || enableMouse(params),
    );
    parser?.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => swallowBlink(params) || disableMouse(params),
    );
    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // Software rendering still works; only throughput suffers.
    }
    // The size this client reports to the pane host. With the host's `window-size latest`, the
    // most recently sized client decides the native window size, so a cropped view reports the
    // cell grid its panel could hold rather than the pane's current native size: a session that
    // started headless at 80x24 then grows to the panel instead of being magnified to fill it.
    let wanted = { cols: terminal.cols, rows: terminal.rows };
    let spawned = false;
    let sentCols = 0;
    let sentRows = 0;
    const sendSize = () => {
      const { cols, rows } = wanted;
      if (!spawned || (cols === sentCols && rows === sentRows)) return;
      sentCols = cols;
      sentRows = rows;
      window.loomTerminal.resize(id, cols, rows);
    };
    // Attach once, at the size the panel has been measured to hold. Attaching first and
    // resizing after makes the host redraw the whole screen a second time; measured first, the
    // attach is a single draw, like a native terminal.
    let disposed = false;
    let spawnRequested = false;
    const spawnClient = () => {
      if (spawnRequested || disposed) return;
      spawnRequested = true;
      void window.loomTerminal
        .spawn({
          id,
          cols: wanted.cols,
          rows: wanted.rows,
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
          sendSize();
          setCommand(result.command);
          setStatus(`pid ${result.pid}`);
          terminal.focus();
        })
        .catch((error: unknown) => {
          if (!disposed) setStatus(String(error));
        });
    };
    const fitView = () => {
      const crop = viewportRef.current;
      const container = clip.current;
      if (crop && container) {
        terminal.resize(crop.columns, crop.rows);
        const screen = element.querySelector<HTMLElement>(".xterm-screen");
        if (!screen?.clientWidth || !screen.clientHeight) {
          // No cell metrics yet (first paint, hidden view): report the native grid as is.
          wanted = { cols: terminal.cols, rows: terminal.rows };
          sendSize();
          // Without layout there is nothing better to measure against; attach as is.
          spawnClient();
          return;
        }
        const cellWidth = screen.clientWidth / terminal.cols;
        const cellHeight = screen.clientHeight / terminal.rows;
        // Every pane of a window shares one native size: the whole tab area in cells, not this
        // panel's slice of it. Otherwise two split panels each report half a window and the
        // window shrinks to the last one, magnifying both.
        const area =
          container.closest<HTMLElement>("[data-panel-host]") ?? container;
        wanted = {
          cols: Math.max(2, Math.floor(area.clientWidth / cellWidth)),
          rows: Math.max(1, Math.floor(area.clientHeight / cellHeight)),
        };
        sendSize();
        spawnClient();
        const placement = terminalCrop(
          crop,
          screen.clientWidth,
          screen.clientHeight,
          container.clientWidth,
          container.clientHeight,
        );
        Object.assign(element.style, {
          width: `${screen.clientWidth}px`,
          height: `${screen.clientHeight}px`,
          transformOrigin: "top left",
          transform: placement,
        });
      } else {
        Object.assign(element.style, {
          width: "100%",
          height: "100%",
          transform: "",
        });
        fit.fit();
        wanted = { cols: terminal.cols, rows: terminal.rows };
        sendSize();
        spawnClient();
      }
    };
    fitViewport.current = fitView;
    fitView();
    instance.current = terminal;
    window.loom.term = terminal;
    window.loom.terms ??= {};
    window.loom.terms[panelId ?? id] = terminal;

    terminal.attachCustomKeyEventHandler((event) => {
      // Workbench's window capture listener owns bindings across every focus
      // surface. It consumes them before xterm/kitty; never run a second matcher.
      if (event.defaultPrevented) return false;
      if (
        settings.current.onKey?.(event, () =>
          window.loomTerminal.write(id, "\x01"),
        )
      )
        return false;
      if (event.type !== "keydown") return true;
      const encoded = kittyEncode(event);
      if (!encoded) return true;
      window.loomTerminal.write(id, encoded);
      return false;
    });

    terminal.onData((data) => window.loomTerminal.write(id, data));
    terminal.onResize(() => {
      if (viewportRef.current) return; // a cropped view's size is decided by its panel above
      wanted = { cols: terminal.cols, rows: terminal.rows };
      sendSize();
    });
    // Synchronized updates (DECSET 2026): the pane host marks where a redraw begins and ends.
    // Everything between is held and written as one frame, so the cursor never appears at the
    // intermediate positions a redraw passes through. A missing end marker flushes after 50 ms.
    const SYNC_BEGIN = "\x1b[?2026h";
    const SYNC_END = "\x1b[?2026l";
    let held = "";
    let holding = false;
    let holdTimer: number | undefined;
    const flushHeld = () => {
      window.clearTimeout(holdTimer);
      holdTimer = undefined;
      if (held) terminal.write(held);
      held = "";
      holding = false;
    };
    window.loomTerminal.onData(id, (data) => {
      let input = data;
      while (input) {
        if (!holding) {
          const begin = input.indexOf(SYNC_BEGIN);
          if (begin < 0) {
            terminal.write(input);
            return;
          }
          if (begin > 0) terminal.write(input.slice(0, begin));
          input = input.slice(begin + SYNC_BEGIN.length);
          holding = true;
          holdTimer = window.setTimeout(flushHeld, 50);
        } else {
          const end = input.indexOf(SYNC_END);
          if (end < 0) {
            held += input;
            return;
          }
          held += input.slice(0, end);
          input = input.slice(end + SYNC_END.length);
          flushHeld();
        }
      }
    });
    window.loomTerminal.onExit(id, ({ exitCode }) => {
      // Exit 1 from an attach means "already attached" or "taken over"; both are states the
      // human resolves, never something Loom retries on its own (spike 03).
      setStatus(
        exitCode === 0
          ? "detached"
          : `exited ${exitCode} - reattach from the toolbar`,
      );
    });

    // Resize on panel resize only, debounced: the attached client owns the pane size for
    // every other viewer, and that size sticks after detach (spike 03).
    let timer: number | undefined;
    const resizeElement = clip.current ?? element;
    let width = resizeElement.clientWidth;
    let height = resizeElement.clientHeight;
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
          fitView();
        } catch {
          // The panel can be detached mid-animation.
        }
      }, 80);
    });
    observer.observe(resizeElement);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      observer.disconnect();
      fitViewport.current = null;
      element.removeEventListener("wheel", onWheel, { capture: true });
      window.clearTimeout(copyTimer);
      copyDisposable?.dispose();
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
        <div className="terminal-crop" ref={clip}>
          <div className="terminal-viewport" ref={host} />
        </div>
      </div>
    </div>
  );
});
