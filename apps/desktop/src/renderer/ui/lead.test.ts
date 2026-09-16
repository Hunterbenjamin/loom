// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { defaultKeybindingsState } from "../../shared/keybindings.js";
import { App } from "../app.js";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { cursorItems, listItemKey, selectedRows } from "../store/selectors.js";
import { WindowKeybindings } from "../window-keybindings.js";
import { WindowModeContext } from "../window-mode.js";
import { LeadBar } from "./lead.js";

// These tests exercise window shortcuts, not WebGL or terminal rendering.
vi.mock("./terminal.js", () => ({
  enterFocusedScrollMode: vi.fn(),
  TerminalTab: () => null,
  TaskShellTerminal: () => null,
}));

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

function mount() {
  const store = createStore(buildSnapshot(20));
  window.loomHost = {
    ...window.loomHost,
    interactive: vi.fn(),
    setMode: vi.fn(),
    mode: vi.fn(),
    onModeChanged: vi.fn(() => () => {}),
    chooseRepository: vi.fn(),
    keybindings: vi.fn(async () => defaultKeybindingsState),
    onKeybindingsChanged: vi.fn(() => () => {}),
    openWindow: vi.fn(),
    connection: vi.fn(),
    metrics: vi.fn(),
    platform: "darwin",
  };
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
        // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
        children: createElement(WindowKeybindings, null, createElement(App)),
      }),
    ),
  );
  return { store, host };
}

test("Cmd+J opens a floating Main chat without mounting a terminal", async () => {
  const { store, host } = mount();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", metaKey: true }),
    ),
  );
  expect(
    host.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
  ).toBe("Main chat");
  expect(host.querySelector(".lead-panel")).toBeNull();
  expect(host.querySelector(".terminal")).toBeNull();
  expect(store.getState().ui.chatTarget).toEqual({
    kind: "lead",
    repoId: store.getState().ui.repo,
  });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Expand chat"]')
      ?.click(),
  );
  expect(
    host.querySelector(".chat-window")?.classList.contains("expanded"),
  ).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Minimize chat"]')
      ?.click(),
  );
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(
    host.querySelector(".lead-toggle")?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(document.activeElement).toBe(host.querySelector(".main"));
});

test.each(["Escape", "Cmd+J", "Minimize chat", "Close chat", "Main toggle"])(
  "%s returns Main focus to the tracker so Enter opens the selected issue",
  async (dismiss) => {
    const { store, host } = mount();
    act(() => store.setCursor(1));
    const selected = listItemKey(cursorItems(store.getState())[1]!);
    const toggle = host.querySelector<HTMLButtonElement>(".lead-toggle")!;
    // Include the case where opening Main starts with focus on its button.
    toggle.focus();
    await act(async () => {
      if (dismiss === "Escape") {
        toggle.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "j",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      } else toggle.click();
    });
    const composer = host.querySelector<HTMLTextAreaElement>(
      ".chat-composer textarea",
    )!;
    composer.focus();
    await act(async () => {
      if (dismiss === "Escape" || dismiss === "Cmd+J") {
        composer.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: dismiss === "Escape" ? "Escape" : "j",
            metaKey: dismiss === "Cmd+J",
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        const button =
          dismiss === "Main toggle"
            ? toggle
            : host.querySelector<HTMLButtonElement>(
                `[aria-label="${dismiss}"]`,
              )!;
        button.focus();
        button.click();
      }
    });
    expect(host.querySelector(".chat-window")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".main"));
    // Wheel scrolling does not run a tracker key or clear control focus.
    document.activeElement!.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true }),
    );
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.activeElement!.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(store.getState().ui.openTask).toBe(selected);
    expect(host.querySelector(".chat-window")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".pr-page-head"));
  },
);

test("closing Main in a detail returns focus to its keyboard scroll target", async () => {
  const { store, host } = mount();
  await act(async () => store.open(selectedRows(store.getState())[0]!.task.id));
  const header = host.querySelector<HTMLElement>(".pr-page-head")!;
  await act(async () => store.toggleMainChat());
  host.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!.focus();
  await act(async () => store.setChatView("minimized"));
  expect(document.activeElement).toBe(header);
  const body = host.querySelector<HTMLElement>(".pr-page-body")!;
  const before = body.scrollTop;
  await act(async () =>
    header.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "j",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(body.scrollTop).toBe(before + 60);
});

test("a deliberately focused Main button retains native Enter activation", () => {
  const { store, host } = mount();
  const toggle = host.querySelector<HTMLButtonElement>(".lead-toggle")!;
  toggle.focus();
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  toggle.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(store.getState().ui.openTask).toBeNull();
  expect(toggle.tabIndex).toBe(0);
});

test("Open terminal asks the Workbench to select Main", async () => {
  const { host } = mount();
  const opened = vi.fn();
  window.addEventListener("loom:open-chat-terminal", opened, { once: true });
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", metaKey: true }),
    ),
  );
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>(".chat-menu button")]
      .find((button) => button.textContent === "Open terminal")
      ?.click(),
  );
  expect(window.loomHost.setMode).toHaveBeenCalledWith("workbench");
  expect(opened).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: expect.objectContaining({ kind: "lead" }),
    }),
  );
});

test("only the active retained surface handles Cmd+J", async () => {
  const store = createStore(buildSnapshot(20));
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
        // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
        children: createElement(
          WindowModeContext,
          { value: "tracker" },
          createElement(
            Fragment,
            null,
            createElement(LeadBar, { surface: "tracker" }),
            createElement(LeadBar, { surface: "workbench" }),
          ),
        ),
      }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", metaKey: true }),
    ),
  );
  expect(store.getState().ui.chatView).toBe("open");
  expect(host.querySelectorAll('[aria-label="Main chat"]')).toHaveLength(1);
});

test("an empty Tracker offers Open repository without opening Main", async () => {
  const store = createStore({ ...buildSnapshot(0), repos: [], tasks: [] });
  const chooseRepository = vi.fn(async () => null);
  window.loomHost = {
    ...window.loomHost,
    interactive: vi.fn(),
    chooseRepository,
    mode: vi.fn(),
    setMode: vi.fn(),
    onModeChanged: vi.fn(() => () => {}),
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
        // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
        children: createElement(WindowKeybindings, null, createElement(App)),
      }),
    ),
  );
  expect(host.querySelector<HTMLButtonElement>(".lead-toggle")?.disabled).toBe(
    true,
  );
  expect(host.querySelector(".chat-window")).toBeNull();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Open repository…")
      ?.click(),
  );
  expect(chooseRepository).toHaveBeenCalledTimes(1);
});

test("the bottom bar's Main shows the shared agent indicator and no inbox count", async () => {
  const store = createStore(buildSnapshot(20));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  const render = () =>
    act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
          children: createElement(
            WindowModeContext,
            { value: "workbench" },
            createElement(LeadBar, { surface: "tracker" }),
          ),
        }),
      ),
    );
  const status = () =>
    host.querySelector<HTMLElement>(".lead-toggle .wb-status");
  const set = (status: "working" | "idle", unread: boolean) => {
    const state = store.getState();
    Object.assign(state, {
      lead: { ...state.lead, status },
      mainFinished: unread,
    });
  };

  set("working", false);
  await render();
  expect(status()?.classList.contains("working")).toBe(true);
  set("idle", true);
  await render();
  expect(status()?.classList.contains("finished")).toBe(true);
  set("idle", false);
  await render();
  expect(status()?.classList.contains("idle")).toBe(true);
  expect(host.querySelector(".lead-toggle")?.textContent).not.toMatch(/\d/);
});
