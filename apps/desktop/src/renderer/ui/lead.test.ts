// @vitest-environment happy-dom
import { applyPatch, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../app.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";

const renders = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("./list.js", async (original) => {
  const module = await original<typeof import("./list.js")>();
  return {
    ListView() {
      renders.list();
      return createElement(module.ListView);
    },
  };
});
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 32,
    getVirtualItems: () => [],
    scrollToIndex() {},
  }),
}));
// Mock xterm's renderer only: exercise the real shared TerminalSession and IPC lifecycle.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 100;
    rows = 24;
    unicode = { activeVersion: "" };
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-unicode-graphemes", () => ({
  UnicodeGraphemesAddon: class {},
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => {
    for (const fn of cleanups.splice(0)) fn();
  });
  vi.clearAllMocks();
});

for (const live of [false, true])
  test(`Lead bottom bar and attach/detach leave list render count unchanged (${live ? "live" : "fixtures"})`, async () => {
    const fixture = buildSnapshot(20);
    const store = createStore(fixture, live, live ? "dev" : "fixtures");
    if (live) store.setConnection("connected");
    const spawn = vi.fn(
      async (_request: import("../../shared/ipc.js").PtySpawnRequest) => ({
        pid: 123,
        command: "test attach",
      }),
    );
    const kill = vi.fn(async () => true);
    window.loomTerminal = {
      spawn,
      kill,
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      off: vi.fn(),
    };
    window.loomHost = {
      interactive() {},
      connection: vi.fn(),
      metrics: vi.fn(),
      platform: "darwin",
    };
    window.loom = { store, ready: true, diffPaintedAt: null, term: null };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(() => {
      root.unmount();
      host.remove();
    });
    await act(async () =>
      root.render(
        // biome-ignore lint/correctness/noChildrenProp: The provider requires children in its typed props.
        createElement(StoreProvider, { store, children: createElement(App) }),
      ),
    );
    expect(host.querySelector(".bottom-bar")?.textContent).toContain(
      live ? "connected · dev" : "fixtures · fixtures",
    );
    const initial = renders.list.mock.calls.length;
    const beforeTasks = store.getState().snapshot.tasks;
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".lead-toggle")?.click(),
    );
    // The terminal is intentionally lazy to preserve cold-start performance.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toMatchObject([
      { label: "Lead", lead: true, runId: null },
    ]);
    const request = spawn.mock.calls[0]?.[0];
    if (!request) throw new Error("No terminal spawned");
    const id = request.id;
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", metaKey: true }),
      ),
    );
    expect(host.querySelector(".lead-panel")).toBeNull();
    expect(kill).toHaveBeenCalledWith(id);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", metaKey: true }),
      ),
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(renders.list).toHaveBeenCalledTimes(initial);
    expect(store.getState().snapshot.tasks).toBe(beforeTasks);
    if (live) {
      const { body, meta } = toSnapshot(fixture);
      const client = stateFromSnapshot(meta, body);
      const patch = {
        type: "patch" as const,
        seq: meta.seq + 1,
        now: meta.now,
        changes: [
          {
            op: "upsert" as const,
            collection: "lead" as const,
            value: {
              id: "lead" as const,
              sessionId: null,
              status: "working" as const,
            },
          },
        ],
      };
      const applied = applyPatch(client, patch);
      if (!applied.ok) throw new Error("Patch failed");
      await act(async () => store.applyProtocol(client, patch));
      expect(host.querySelector(".lead-header")?.textContent).toContain(
        "working",
      );
      expect(renders.list).toHaveBeenCalledTimes(initial);
      const sender = vi.fn(async () => ({
        ok: true as const,
        result: { kind: "lead_stopped" as const },
      }));
      store.setSender(sender);
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Restart")
          ?.click(),
      );
      expect(sender).toHaveBeenCalledExactlyOnceWith({
        kind: "stop_lead_session",
      });
      expect(spawn).toHaveBeenCalledTimes(3);
    }
  });
