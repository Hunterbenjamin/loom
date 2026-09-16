// @vitest-environment happy-dom
import { stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { defaultKeybindingsState } from "../../shared/keybindings.js";
import { minutesBefore, runId } from "../fixtures/ids.js";
import { buildSnapshot, type Snapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { WindowKeybindings } from "../window-keybindings.js";
import { TerminalTab } from "./terminal.js";

const created = vi.hoisted(() => vi.fn());
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      created(this);
    }
    options = {};
    cols = 100;
    rows = 24;
    unicode = { activeVersion: "" };
    loadAddon() {}
    textarea = document.createElement("textarea");
    open(host: HTMLElement) {
      host.append(this.textarea);
      this.textarea.addEventListener("keydown", (event) => {
        if (this.handler(event)) this.data(event.key);
      });
    }

    handler = (_event: KeyboardEvent) => true;
    data = (_data: string) => {};
    buffer = { active: { type: "normal", viewportY: 50, baseY: 100 } };
    scroll = () => {};
    onScroll(fn: () => void) {
      this.scroll = fn;
    }
    scrollLines = vi.fn((lines: number) => {
      this.buffer.active.viewportY = Math.max(
        0,
        Math.min(100, this.buffer.active.viewportY + lines),
      );
      this.scroll();
    });
    scrollToTop = vi.fn(() => {
      this.buffer.active.viewportY = 0;
      this.scroll();
    });
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = 100;
      this.scroll();
    });
    csi = new Map<string, (params: number[]) => boolean>();
    parser = {
      registerCsiHandler: (
        key: { prefix?: string; final: string },
        fn: (params: number[]) => boolean,
      ) => this.csi.set((key.prefix ?? "") + key.final, fn),
    };
    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
      this.handler = fn;
    }
    onData(fn: (data: string) => void) {
      this.data = fn;
    }
    onResize() {}
    write() {}
    focus() {
      this.textarea.focus();
    }
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
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.clearAllMocks();
});

function terminalFixture() {
  const fixture = buildSnapshot();
  const source = fixture.runs.find((run) => run.mode === "interactive");
  const sourceTask = source
    ? fixture.tasks.find((task) => task.id === source.taskId)
    : undefined;
  if (!source || !sourceTask) throw new Error("No interactive fixture run");
  const task = { ...sourceTask, stage: "in_progress" as const };
  const snapshot: Snapshot = {
    ...fixture,
    tasks: [task],
    runs: [],
    questions: [],
    messages: [],
    findings: [],
    approvals: [],
    plans: {},
    testResults: [],
    transitions: [],
    comments: [],
    viewedFiles: {},
  };
  const makeRun = (id: string, launchedMinutesAgo: number) => ({
    ...source,
    id: runId(id),
    taskId: task.id,
    status: "working" as const,
    launchedAt: minutesBefore(launchedMinutesAgo),
    endedAt: null,
  });
  return { snapshot, task, makeRun };
}

function renderTerminal(snapshot: Snapshot) {
  const task = snapshot.tasks[0];
  if (!task) throw new Error("No task");
  const store = createStore(snapshot, "dev");
  store.setSender(async () => ({
    ok: true,
    result: {
      kind: "task_terminal",
      taskId: task.id,
      target: {
        hostGeneration: "loom-test#1",
        sessionName: "task-shell",
        windowId: "@1",
        paneId: "%1",
      },
      source: task.stage === "done" ? "project" : "worktree",
      branch: "feat/current-branch",
    },
  }));
  const spawn = vi.fn(
    async (request: import("../../shared/ipc.js").PtySpawnRequest) => ({
      pid: 123,
      command: `attach ${request.runId ?? "lead"}`,
    }),
  );
  const kill = vi.fn(async () => true);
  window.loomTerminal = {
    paneFlags: vi.fn(async () => ({ alternate: false })),
    spawn,
    kill,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    off: vi.fn(),
  };
  window.loom = { store, ready: true, term: null };
  window.loomHost = {
    keybindings: async () => defaultKeybindingsState,
    onKeybindingsChanged: () => () => {},
  } as unknown as typeof window.loomHost;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: The provider requires children in its typed props.
        children: createElement(
          WindowKeybindings,
          { mode: "tracker" },
          createElement(TerminalTab, { task, theme: "dark" }),
        ),
      }),
    ),
  );
  return { host, kill, spawn, store };
}

async function replaceSnapshot(
  store: ReturnType<typeof createStore>,
  snapshot: Snapshot,
) {
  const { body, meta } = toSnapshot(snapshot);
  await act(async () => store.applyProtocol(stateFromSnapshot(meta, body)));
}

test("a single run attaches immediately without a picker", () => {
  const { snapshot, makeRun } = terminalFixture();
  const only = makeRun("only", 1);
  const { host, spawn } = renderTerminal({ ...snapshot, runs: [only] });

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]?.[0]).toMatchObject({ runId: only.id });
  expect(created).toHaveBeenCalledTimes(1);
  expect(host.querySelector("select")).toBeNull();
  expect(host.querySelector('[role="tablist"]')).toBeNull();
});

test("switching run tabs preserves every terminal client", () => {
  const { snapshot, makeRun } = terminalFixture();
  const older = makeRun("older", 10);
  const newer = makeRun("newer", 1);
  const { host, kill, spawn } = renderTerminal({
    ...snapshot,
    runs: [older, newer],
  });

  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Implementer · claude",
    "Implementer · claude",
  ]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  expect(spawn.mock.calls.map((call) => call[0].runId)).toEqual([
    newer.id,
    older.id,
  ]);
  expect(created).toHaveBeenCalledTimes(2);

  act(() => tabs[1]?.click());
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(created).toHaveBeenCalledTimes(2);
  expect(kill).not.toHaveBeenCalled();
});

test("run changes detach and mount only changed clients and select the newest fallback", async () => {
  const { snapshot, makeRun } = terminalFixture();
  const oldest = makeRun("oldest", 20);
  const current = makeRun("current", 10);
  const initial = { ...snapshot, runs: [oldest, current] };
  const { host, kill, spawn, store } = renderTerminal(initial);
  await act(async () => {
    await Promise.resolve();
  });
  const oldestTab = [
    ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((tab) => tab.getAttribute("aria-controls")?.includes(oldest.id));
  act(() => oldestTab?.click());

  const newest = makeRun("newest", 1);
  await replaceSnapshot(store, { ...snapshot, runs: [current, newest] });

  expect(spawn).toHaveBeenCalledTimes(3);
  expect(spawn.mock.calls[2]?.[0]).toMatchObject({ runId: newest.id });
  expect(created).toHaveBeenCalledTimes(3);
  expect(kill).toHaveBeenCalledTimes(1);
  const active = host.querySelector('[role="tab"][aria-selected="true"]');
  expect(active?.getAttribute("aria-controls")).toContain(newest.id);
});

test("empty and completed tasks automatically attach their resolved shell", async () => {
  const first = terminalFixture();
  const empty = renderTerminal(first.snapshot);
  await act(async () => {
    await Promise.resolve();
  });
  expect(empty.host.textContent).toContain(
    "Issue worktree · feat/current-branch",
  );
  expect(empty.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      pane: expect.objectContaining({ sessionName: "task-shell" }),
      runId: null,
    }),
  );

  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const second = terminalFixture();
  const stale = second.makeRun("stale", 1);
  const doneTask = { ...second.task, stage: "done" as const };
  const done = renderTerminal({
    ...second.snapshot,
    tasks: [doneTask],
    runs: [stale],
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(done.host.textContent).toContain("Project root · feat/current-branch");
  expect(done.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      pane: expect.objectContaining({ sessionName: "task-shell" }),
      runId: null,
    }),
  );
});

function scrollHarness() {
  const { snapshot, makeRun } = terminalFixture();
  const rendered = renderTerminal({
    ...snapshot,
    runs: [makeRun("scroll", 1)],
  });
  const terminal = created.mock.calls.at(-1)?.[0] as {
    handler: (event: KeyboardEvent) => boolean;
    data: (data: string) => void;
    scrollLines: ReturnType<typeof vi.fn>;
    scrollToTop: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn<() => void>>;
    csi: Map<string, (params: number[]) => boolean>;
  };
  const controller = Object.values(window.loom.terminalControllers ?? {})[0];
  if (!controller) throw new Error("Missing terminal controller");
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      cancelable: true,
      ...init,
    });
    act(() => {
      if (terminal.handler(event)) terminal.data(key);
    });
    return event;
  };
  return { ...rendered, terminal, controller, press };
}

test("scroll mode consumes input, navigates history and exits to normal input", async () => {
  const { host, terminal, controller, press } = scrollHarness();
  await act(async () => {
    await controller.enterScrollMode();
  });
  expect(host.textContent).toContain("SCROLL");
  press("j");
  press("k");
  press("d", { ctrlKey: true });
  press("u", { ctrlKey: true });
  press(" ", { shiftKey: true });
  press(" ");
  expect(terminal.scrollLines.mock.calls).toEqual([
    [1],
    [-1],
    [12],
    [-12],
    [-24],
    [24],
  ]);
  press("g");
  press("x");
  expect(host.textContent).not.toContain("SCROLL");
  expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
    expect.any(String),
    "x",
  );
  await act(async () => {
    await controller.enterScrollMode();
  });
  press("g");
  expect(terminal.scrollToTop).not.toHaveBeenCalled();
  press("g");
  expect(terminal.scrollToTop).toHaveBeenCalledOnce();
  press("G", { shiftKey: true });
  expect(host.textContent).not.toContain("SCROLL");
  await act(async () => {
    await controller.enterScrollMode();
  });
  expect(press("Escape").defaultPrevented).toBe(true);
  expect(host.textContent).not.toContain("SCROLL");
  expect(terminal.scrollToBottom).toHaveBeenCalledTimes(3);
  for (const key of ["j", "k", "q", "Escape", "PageUp"]) {
    press(key);
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      key,
    );
  }
  await act(async () => {
    await controller.enterScrollMode();
  });
  press("q");
  expect(host.textContent).not.toContain("SCROLL");
  expect(terminal.scrollToBottom).toHaveBeenCalledTimes(4);
});

test("shift page keys and the wheel enter reading mode and the bottom leaves it", async () => {
  const { host, terminal, press } = scrollHarness();
  expect(press("PageUp", { shiftKey: true }).defaultPrevented).toBe(true);
  await act(async () => {});
  press("PageDown", { shiftKey: true });
  await act(async () => {});
  act(() =>
    host.querySelector(".terminal-viewport")?.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -48,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(terminal.scrollLines.mock.calls).toEqual([[-24], [24], [-2]]);
  expect(window.loomTerminal.write).not.toHaveBeenCalled();
  expect(host.textContent).toContain("SCROLL");
  act(() => terminal.scrollToBottom());
  expect(host.textContent).not.toContain("SCROLL");
});

test("alternate-screen entry refuses and ordinary reading keys reach the program", async () => {
  const { host, terminal, controller, press } = scrollHarness();
  window.loomTerminal.paneFlags = vi.fn(async () => ({ alternate: true }));
  terminal.csi.get("?h")?.([1000]);
  await act(async () => {
    expect(await controller.enterScrollMode()).toBe(false);
  });
  expect(host.textContent).not.toContain("SCROLL");
  expect(host.textContent).toContain(
    "alternate screen; viewer scrollback is unavailable",
  );
  for (const key of ["j", "k", "PageUp", " ", "g", "G", "q"]) {
    press(key);
    expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
      expect.any(String),
      key,
    );
  }
  expect(terminal.scrollLines).not.toHaveBeenCalled();
  expect(terminal.scrollToTop).not.toHaveBeenCalled();
  expect(terminal.scrollToBottom).not.toHaveBeenCalled();
});

test("Cmd arrows page viewer history from typing without mouse reports", async () => {
  const { host, terminal, press } = scrollHarness();
  await act(async () => {
    press("ArrowUp", { metaKey: true });
  });
  expect(host.textContent).toContain("SCROLL");
  press("ArrowDown", { metaKey: true });
  expect(terminal.scrollLines.mock.calls).toEqual([[-24], [24]]);
  expect(window.loomTerminal.write).not.toHaveBeenCalled();
});

test("unmount removes terminal controllers and focused terminal", async () => {
  const { controller } = scrollHarness();
  await act(async () => {
    await controller.enterScrollMode();
  });
  expect(window.loom.focusedTerminal).toBeDefined();
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  expect(window.loom.terminalControllers).toEqual({});
  expect(window.loom.focusedTerminal).toBeUndefined();
});

test.each(["run", "shell"])(
  "tracker %s terminal handles prefix without ever mounting Workbench",
  async (kind) => {
    const { snapshot, makeRun } = terminalFixture();
    const { host } = renderTerminal({
      ...snapshot,
      runs: kind === "run" ? [makeRun("tracker", 1)] : [],
    });
    await act(async () => {});
    const input = host.querySelector("textarea");
    if (!input) throw new Error("Missing terminal input");
    const press = (key: string, init: KeyboardEventInit = {}) =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ...init,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    await press(" ", { ctrlKey: true });
    await press("[");
    expect(host.textContent).toContain("SCROLL");
    await press("k");
    expect(created.mock.calls.at(-1)?.[0].scrollLines).toHaveBeenCalledWith(-1);
    expect(window.loomTerminal.write).not.toHaveBeenCalled();
    await press("q");
    await press(" ", { ctrlKey: true });
    await press("y");
    expect(window.loomTerminal.write).not.toHaveBeenCalled();
  },
);

test("a refused paging shortcut returns through xterm, while only the wheel writes SGR reports", async () => {
  const { host, terminal } = scrollHarness();
  await act(async () => {});
  window.loomTerminal.paneFlags = vi.fn(async () => ({ alternate: true }));
  terminal.csi.get("?h")?.([1000]);
  const input = host.querySelector("textarea");
  if (!input) throw new Error("Missing terminal input");
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "PageUp",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(window.loomTerminal.write).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    "\x1b[5;2~",
  );
  expect(terminal.scrollLines).not.toHaveBeenCalled();
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 24 }) as DOMRect;
  host.querySelector(".terminal-viewport")?.append(screen);
  const wheel = new WheelEvent("wheel", {
    deltaY: -24,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(wheel, {
    clientX: { value: 50 },
    clientY: { value: 12 },
  });
  await act(async () => screen.dispatchEvent(wheel));
  expect(window.loomTerminal.write).toHaveBeenLastCalledWith(
    expect.any(String),
    "\x1b[<64;51;13M",
  );
});

test("reading keys wait for prefix entry and late flag replies cannot revive an unmounted terminal", async () => {
  const { host } = scrollHarness();
  await act(async () => {});
  let resolve!: (flags: { alternate: boolean }) => void;
  window.loomTerminal.paneFlags = () =>
    new Promise((done) => {
      resolve = done;
    });
  const input = host.querySelector("textarea");
  if (!input) throw new Error("Missing terminal input");
  await act(async () => {
    for (const [key, ctrlKey] of [
      [" ", true],
      ["[", false],
      ["k", false],
    ] as const)
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  expect(window.loomTerminal.write).not.toHaveBeenCalled();
  await act(async () => resolve({ alternate: false }));
  expect(host.textContent).toContain("SCROLL");
  expect(created.mock.calls.at(-1)?.[0].scrollLines).toHaveBeenCalledWith(-1);
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "[",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  await act(async () => resolve({ alternate: false }));
  expect(window.loom.focusedTerminal).toBeUndefined();
  expect(window.loomTerminal.write).not.toHaveBeenCalled();
});
