// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../app.js";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore as createStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { WindowModeContext } from "../window-mode.js";
import { LeadBar } from "./lead.js";

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
    keybindings: vi.fn(),
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
      // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
      createElement(StoreProvider, { store, children: createElement(App) }),
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
  expect(document.activeElement).toBe(host.querySelector(".lead-toggle"));
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
      // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
      createElement(StoreProvider, { store, children: createElement(App) }),
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
