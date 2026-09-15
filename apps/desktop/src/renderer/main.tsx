import {
  Activity,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { TrackerClient } from "../shared/client.js";
import { connectionConfig } from "../shared/connection.js";
import { defaultKeybindings } from "../shared/keybindings.js";
import { selectedDetailTask } from "./store/detail-selection.js";

const App = lazy(() => import("./app.js").then((m) => ({ default: m.App })));
const Workbench = lazy(() =>
  import("./workbench/workbench.js").then((m) => ({ default: m.Workbench })),
);

import { emptySnapshot } from "./live/snapshot.js";
import { pullRequestSubscriptions } from "./store/pull-requests.js";
import { StoreProvider, useStore } from "./store/react.js";
import { createStore } from "./store/store.js";
import { TerminalHistoryContext } from "./ui/terminal.js";
import { WindowModeContext } from "./window-mode.js";
import "./styles/index.css";
import { PaneChime } from "./workbench/chime.js";

let nativeFingerprint = "";
async function synchronizeNativeSettings() {
  const document = store
    .getState()
    .settings.find((item) => item.id === "global");
  if (!document) return;
  const { appearance } = document.effective;
  const native = {
    version: 1 as const,
    windowMode: appearance.windowMode,
    terminalHistoryLimit: appearance.terminalHistoryLimit,
    keybindings: {
      version: 1 as const,
      prefix: appearance.keyPrefix,
      prefixTimeoutMs: appearance.keyTimeoutMs,
      // Actions added since the bindings were stored keep their defaults.
      bindings: { ...defaultKeybindings.bindings, ...appearance.keybindings },
    },
  };
  const fingerprint = JSON.stringify(native);
  if (fingerprint === nativeFingerprint) return;
  await window.loomHost.applyNativeSettings?.(native);
  nativeFingerprint = fingerprint;
}
const initialMode = await window.loomHost.mode();
const config = connectionConfig.parse(await window.loomHost.connection());
const store = createStore(
  emptySnapshot(),
  config.mode === "live" ? config.instance : "unconfigured",
);
const requestNativeSynchronization = () => {
  void synchronizeNativeSettings().catch(() => {
    // Coordinator data remains authoritative; reconnect or the next patch retries the mirror.
  });
};
store.subscribe(requestNativeSynchronization);
requestNativeSynchronization();
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
    const { openRun, chatTarget, chatView } = store.getState().ui;
    const openTask = selectedDetailTask(store.getState())?.id;
    client.setDetail([
      { kind: "panes" },
      { kind: "agents" },
      ...pullRequestSubscriptions(store.getState()),
      ...(openTask ? [{ kind: "task" as const, taskId: openTask }] : []),
      ...(openRun ? [{ kind: "run" as const, runId: openRun }] : []),
      ...(chatTarget && chatView !== "minimized"
        ? [{ kind: "conversation" as const, target: chatTarget }]
        : []),
    ]);
  });
  client.setDetail([{ kind: "panes" }, { kind: "agents" }]);
  client.start();
  window.addEventListener("beforeunload", () => client.stop(), { once: true });
} else if (config.mode === "unconfigured") store.setConnection(config.message);

/**
 * The window paints the list first and pulls the diff renderer in behind it. Loading Pierre and
 * Shiki up front costs about half the cold-start budget for something no first screen shows.
 */
function Boot() {
  const [mode, setMode] = useState(initialMode);
  const [visited, setVisited] = useState(new Set([initialMode]));
  useEffect(
    () =>
      window.loomHost.onModeChanged((next) => {
        setVisited((previous) => new Set([...previous, next]));
        setMode(next);
      }),
    [],
  );
  const [Pool, setPool] = useState<ComponentType<{
    children: ReactNode;
  }> | null>(null);
  useEffect(() => {
    if (mode === "workbench") return;
    let cancelled = false;
    void import("./ui/pool.js").then((module) => {
      if (!cancelled) setPool(() => module.DiffPool);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const app = (
    <StoreProvider store={store}>
      <TerminalSettings>
        <WindowModeContext value={mode}>
          <PaneChime />
          <Suspense fallback={<div>Opening {mode}…</div>}>
            {visited.has("tracker") && (
              <Activity mode={mode === "tracker" ? "visible" : "hidden"}>
                <App />
              </Activity>
            )}
            {visited.has("workbench") && (
              <Activity mode={mode === "workbench" ? "visible" : "hidden"}>
                <Workbench />
              </Activity>
            )}
          </Suspense>
        </WindowModeContext>
      </TerminalSettings>
    </StoreProvider>
  );
  return Pool ? <Pool>{app}</Pool> : app;
}

function TerminalSettings({ children }: { children: ReactNode }) {
  const limit = useStore(
    (state) =>
      state.settings.find((item) => item.id === "global")?.effective.appearance
        .terminalHistoryLimit ?? 10_000,
  );
  return (
    <TerminalHistoryContext value={limit}>{children}</TerminalHistoryContext>
  );
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
      /** The live xterm instance, so the harness can time keystroke to glyph. */
      term: unknown;
      terms?: Record<string, unknown>;
      terminalRenders?: Record<string, number>;
    };
  }
}
window.loom = { store, ready: true, term: null };
