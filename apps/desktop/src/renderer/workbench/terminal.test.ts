// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { TerminalSession, TerminalTab } from "../ui/terminal.js";

const created = vi.hoisted(() => vi.fn());
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      created();
    }
    options = {};
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
const target = {
  hostGeneration: "loom-test#1",
  sessionName: "shell",
  windowId: "@1",
  paneId: "%1",
};
test("task detail automatically resolves its own terminal, displays the actual branch and ignores old run selection", async () => {
  const store = createStore(undefined, true, "test");
  const task = store.getState().snapshot.tasks[0];
  if (!task) throw new Error("Missing task fixture");
  store.setRun("unrelated-run" as never);
  const send = vi.fn(async () => ({
    ok: true as const,
    result: {
      kind: "task_terminal" as const,
      taskId: task.id,
      target,
      source: "project" as const,
      branch: "feat/keep-current",
    },
  }));
  store.setSender(send);
  const spawn = vi.fn(async () => ({ pid: 1, command: "attach" }));
  window.loomTerminal = {
    spawn,
    kill: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    off: vi.fn(),
  };
  window.loom = { store, ready: true, diffPaintedAt: null, term: null };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (title = task.title) =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
        children: createElement(TerminalTab, {
          task: { ...task, title },
          theme: "dark",
        }),
      }),
    );
  try {
    await act(async () => render());
    expect(element.querySelector("select")).toBeNull();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      kind: "open_task_terminal",
      taskId: task.id,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ pane: target, runId: null }),
    );
    expect(element.textContent).toContain("Project root · feat/keep-current");
    await act(async () => render("Updated title"));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("two panel clients are independent; label/theme updates and parent paints preserve xterms; late spawn detaches", async () => {
  created.mockClear();
  const pending: (() => void)[] = [];
  const spawn = vi.fn(
    () =>
      new Promise<{ pid: number; command: string }>((resolve) =>
        pending.push(() => resolve({ pid: 1, command: "attach" })),
      ),
  );
  const kill = vi.fn(async (_id: string) => true);
  window.loomTerminal = {
    spawn,
    kill,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    off: vi.fn(),
  };
  window.loom = {
    store: createStore(),
    ready: true,
    diffPaintedAt: null,
    term: null,
  };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (
    second: boolean,
    theme: "light" | "dark" = "dark",
    label = "a",
  ) =>
    createElement(
      Fragment,
      null,
      createElement(TerminalSession, {
        panelId: "a",
        pane: target,
        live: true,
        theme,
        label,
      }),
      second
        ? createElement(TerminalSession, {
            panelId: "b",
            pane: target,
            live: true,
            theme,
            label: "b",
          })
        : null,
    );
  try {
    await act(async () => root.render(render(true)));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(created).toHaveBeenCalledTimes(2);
    const ids = spawn.mock.calls.map(
      (call) => (call as unknown as [{ id: string }])[0].id,
    );
    expect(new Set(ids).size).toBe(2);
    await act(async () => root.render(render(true, "light", "new label")));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(created).toHaveBeenCalledTimes(2);
    await act(async () => root.render(render(false, "light", "new label")));
    expect(kill).toHaveBeenCalledWith(ids[1]);
    expect(kill).not.toHaveBeenCalledWith(ids[0]);
    await act(async () => {
      for (const resolve of pending) resolve();
    });
    expect(kill.mock.calls.filter((c) => c[0] === ids[1])).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
