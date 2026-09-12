import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TrackerClient } from "../shared/client.js";
import { connectionConfig } from "../shared/connection.js";
import { App } from "./app.js";
import { emptySnapshot } from "./live/snapshot.js";
import { StoreProvider } from "./store/react.js";
import { createStore } from "./store/store.js";
import "./theme.css";

const config = connectionConfig.parse(await window.loomHost.connection());
const store =
  config.mode === "fixtures"
    ? createStore()
    : createStore(emptySnapshot(), true);
if (config.mode === "live") {
  const client = new TrackerClient({
    ...config,
    clientId: `window-${crypto.randomUUID()}`,
    onState: (state, patch) => store.applyProtocol(state, patch),
    onStatus: (status, message) =>
      store.setConnection(message ? `${status}: ${message}` : status),
  });
  store.setSender((command) => client.command(command));
  store.subscribe(() => {
    const { openTask, openRun } = store.getState().ui;
    client.setDetail([
      ...(openTask ? [{ kind: "task" as const, taskId: openTask }] : []),
      ...(openRun ? [{ kind: "run" as const, runId: openRun }] : []),
    ]);
  });
  client.start();
  window.addEventListener("beforeunload", () => client.stop(), { once: true });
} else if (config.mode === "unconfigured") store.setConnection(config.message);

/**
 * The window paints the list first and pulls the diff renderer in behind it. Loading Pierre and
 * Shiki up front costs about half the cold-start budget for something no first screen shows.
 */
function Boot() {
  const [Pool, setPool] = useState<ComponentType<{
    children: ReactNode;
  }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("./ui/pool.js").then((module) => {
      if (!cancelled) setPool(() => module.DiffPool);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const app = (
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  );
  return Pool ? <Pool>{app}</Pool> : app;
}

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(<Boot />);

// The performance harness drives the real renderer through this, the way spike 03 did.
declare global {
  interface Window {
    loom: {
      store: typeof store;
      ready: boolean;
      /** Set by Pierre's post-render callback; the harness times the first diff paint. */
      diffPaintedAt: number | null;
      /** The live xterm instance, so the harness can time keystroke to glyph. */
      term: unknown;
    };
  }
}
window.loom = { store, ready: true, diffPaintedAt: null, term: null };
