import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { inboxRows } from "../store/inbox.js";
import { useStore, useStoreApi } from "../store/react.js";
import { useWindowMode } from "../window-mode.js";
import { attentionPanes } from "../workbench/selectors.js";

const Terminal = lazy(() =>
  import("./terminal.js").then((module) => ({
    default: module.TerminalSession,
  })),
);

/** Window-local panel state: a toggle/resize never updates the task store or its list. */
export function LeadBar({ onAttention }: { onAttention?: () => void } = {}) {
  const mode = useWindowMode();
  const store = useStoreApi();
  const connection = useStore((s) => s.connection);
  const instance = useStore((s) => s.instance);
  const count = useStore((s) => inboxRows(s).length);
  const agentCount = useStore((s) => attentionPanes(s.panes).length);
  const status = useStore((s) => s.lead.status);
  const theme = useStore((s) => s.ui.theme);
  const live = useStore((s) => s.live);
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() =>
    Math.round(window.innerHeight / 3),
  );
  const [generation, setGeneration] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener("loom:open-main", show);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("loom:open-main", show);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const resize = (value: number) =>
    setHeight(Math.max(160, Math.min(window.innerHeight - 100, value)));
  const restart = async () => {
    if (restarting) return;
    setRestarting(true);
    setError(null);
    try {
      if (live) {
        const outcome = await store.command({ kind: "stop_lead_session" });
        if (!outcome.ok) throw new Error(outcome.error.message);
      }
      // The remounted terminal resolves open_lead_session in main after stop completes.
      setGeneration((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not restart Main",
      );
    } finally {
      setRestarting(false);
    }
  };
  return (
    <>
      {open ? (
        <section
          className="lead-panel"
          aria-label="Main panel"
          style={{ height }}
        >
          <hr
            className="lead-resize"
            aria-label="Resize Main panel"
            aria-orientation="horizontal"
            aria-valuenow={height}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                resize(height + (event.key === "ArrowUp" ? 24 : -24));
              }
            }}
            onPointerDown={(event) => {
              drag.current = { y: event.clientY, height };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (drag.current)
                resize(drag.current.height + drag.current.y - event.clientY);
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          />
          <header className="lead-header">
            <strong>Main</strong>
            <span role="status">{live ? status : "idle · preview"}</span>
            <span className="spacer" />
            <button
              type="button"
              disabled={restarting}
              onClick={() => void restart()}
            >
              Restart
            </button>
            <button
              type="button"
              aria-label="Close Main"
              onClick={() => {
                setOpen(false);
                toggle.current?.focus();
              }}
            >
              Close <kbd>⌘J</kbd>
            </button>
          </header>
          {error ? <div role="alert">{error}</div> : null}
          <Suspense fallback={<div className="pad faint">Opening Main…</div>}>
            <Terminal
              key={generation}
              label="Main"
              lead
              live={live}
              theme={theme}
            />
          </Suspense>
        </section>
      ) : null}
      <footer className="bottom-bar">
        <span className="connection-state">
          <span
            className={
              connection === "connected"
                ? "connection-dot connected"
                : "connection-dot"
            }
          />
          {connection} · {instance}
        </span>
        <button
          type="button"
          onClick={() =>
            void window.loomHost.setMode(
              mode === "tracker" ? "workbench" : "tracker",
            )
          }
        >
          {mode === "tracker" ? "Workbench" : "Issue tracker"} <kbd>⌘⇧W</kbd>
        </button>
        <button
          type="button"
          onClick={
            onAttention ?? (() => void window.loomHost.setMode("workbench"))
          }
        >
          Agents needing attention · {agentCount}
        </button>
        <span className="spacer" />
        <button
          ref={toggle}
          type="button"
          className="lead-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Main <span className="lead-badge">{count}</span>
          <kbd>⌘J</kbd>
        </button>
      </footer>
    </>
  );
}
