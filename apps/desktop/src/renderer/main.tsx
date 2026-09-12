import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { StoreProvider } from "./store/react.js";
import { createStore } from "./store/store.js";
import "./theme.css";

const store = createStore();

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
