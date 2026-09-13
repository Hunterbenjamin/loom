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
    options = {};
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
  test(`Main bottom bar and attach/detach leave list render count unchanged (${live ? "live" : "fixtures"})`, async () => {
    const fixture = buildSnapshot(20);
    const firstRepo = fixture.repos[0];
    if (!firstRepo) throw new Error("Missing first repository");
    const store = createStore(fixture, live, live ? "dev" : "fixtures");
    if (live) {
      store.setConnection("connected");
      const { body, meta } = toSnapshot(fixture);
      store.applyProtocol(stateFromSnapshot(meta, body));
    }
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
      chooseRepository: vi.fn(),
      keybindings: vi.fn(),
      onKeybindingsChanged: vi.fn(() => () => {}),
      mode: vi.fn(),
      setMode: vi.fn(),
      onModeChanged: vi.fn(() => () => {}),
      openWindow: vi.fn(),
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
    expect(host.querySelector(".lead-toggle")?.textContent).toContain("Main");
    expect(host.textContent).not.toMatch(/\bLead\b/);
    const initial = renders.list.mock.calls.length;
    const beforeTasks = store.getState().snapshot.tasks;
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".lead-toggle")?.click(),
    );
    // The terminal is intentionally lazy to preserve cold-start performance.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    });
    expect(host.querySelector(".lead-header")?.textContent).toContain("Main");
    expect(host.querySelector(".lead-panel")?.getAttribute("aria-label")).toBe(
      "Main panel",
    );
    expect(spawn.mock.calls[0]).toMatchObject([
      { label: "Main", lead: fixture.repos[0]?.id, runId: null },
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
    await act(async () => window.dispatchEvent(new Event("loom:open-main")));
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
              id: firstRepo.id,
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
        repoId: fixture.repos[0]?.id,
      });
      expect(spawn).toHaveBeenCalledTimes(3);
    }
    const oldAttach = spawn.mock.calls.at(-1)?.[0];
    const secondRepo = fixture.repos[1];
    if (!secondRepo) throw new Error("Missing second repository");
    const beforeSwitch = spawn.mock.calls.length;
    if (live) {
      const { body, meta } = toSnapshot(fixture);
      body.projects = [{ id: "project", repoId: secondRepo.id }];
      await act(async () => store.applyProtocol(stateFromSnapshot(meta, body)));
    } else await act(async () => store.setRepo(secondRepo.id));
    await vi.waitFor(() =>
      expect(spawn).toHaveBeenCalledTimes(beforeSwitch + 1),
    );
    expect(spawn.mock.calls.at(-1)?.[0].lead).toBe(secondRepo.id);
    expect(kill).toHaveBeenCalledWith(oldAttach?.id);
    expect(host.querySelector(".lead-panel")).not.toBeNull();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Close Main"]')
        ?.click(),
    );
    await act(async () => store.setPalette(true));
    const openMain = [
      ...host.querySelectorAll<HTMLElement>("[cmdk-item]"),
    ].find((item) => item.textContent === "Open Main");
    expect(openMain).toBeDefined();
    await act(async () => openMain?.click());
    expect(store.getState().ui.palette).toBe(false);
    expect(host.querySelector('[aria-label="Main panel"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/\bLead\b/);
  });

test("an empty Tracker offers Open repository without opening Main", async () => {
  const store = createStore({ ...buildSnapshot(0), repos: [], tasks: [] });
  const chooseRepository = vi.fn(async () => null);
  window.loomHost = {
    ...window.loomHost,
    interactive: vi.fn(),
    chooseRepository,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider requires children.
        children: createElement(App),
      }),
    ),
  );
  expect(host.textContent).toContain("Choose a project folder to get started.");
  expect(host.querySelector<HTMLButtonElement>(".lead-toggle")?.disabled).toBe(
    true,
  );
  expect(host.querySelector(".lead-panel")).toBeNull();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Open repository…")
      ?.click(),
  );
  expect(chooseRepository).toHaveBeenCalledTimes(1);
  expect(store.getState().snapshot.repos).toEqual([]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
