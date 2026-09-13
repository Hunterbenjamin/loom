// @vitest-environment happy-dom
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { meta } from "../../../../../packages/protocol/src/test-support.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Sidebar } from "./sidebar.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("renders linked and unlinked spaces, independent collapses, filtering and pinned controls", async () => {
  const store = createStore(undefined, true, "test");
  const linked = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%3"]),
    paneId: "%3",
    sessionName: "loom-t-1",
    windowName: "implementer",
    taskLabel: "t-1 · Fix delivery race",
    branch: "fix/delivery-race",
    role: "implementer",
    provider: "codex",
    status: "working",
  };
  const publish = (attention = false) =>
    store.applyProtocol(
      stateFromSnapshot(meta, {
        ...emptySnapshotBody(),
        panes: [pane, { ...linked, attention }],
      }),
    );
  publish();
  window.loomHost = {
    interactive: vi.fn(),
  } as unknown as typeof window.loomHost;
  const choose = vi.fn();
  const openPinned = vi.fn();
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (filter = "") =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
        children: createElement(Sidebar, {
          filter,
          setFilter: vi.fn(),
          choose,
          openGroup: vi.fn(),
          hidePanels: vi.fn(),
          hasPanels: () => false,
          copyAttach: vi.fn(),
          newTerminal: vi.fn(),
          openPinned,
        }),
      }),
    );
  try {
    await act(async () => render());
    const space = element.querySelector<HTMLElement>(
      '[aria-label="t-1 · Fix delivery race"]',
    );
    expect(space?.textContent).toContain("implementer · codex");
    expect(space?.textContent).toContain("Working");
    expect(space?.querySelector(".wb-space-branch")?.textContent).toBe(
      "fix/delivery-race",
    );
    expect(
      element.querySelector('[aria-label="research"] .wb-space-branch')
        ?.textContent,
    ).toBe("—");
    expect(
      element.querySelector('[aria-label="research"]')?.textContent,
    ).toContain("shell");
    expect(
      element.querySelector('[aria-label="research"]')?.textContent,
    ).toContain("sh");
    expect(element.querySelector(".wb-pinned")).toBe(
      element.querySelector("aside")?.lastElementChild,
    );
    const paneButton = () =>
      element.querySelector<HTMLButtonElement>(
        '[aria-label="Open implementer implementer · codex %3"]',
      );
    await act(async () => paneButton()?.click());
    expect(choose).toHaveBeenLastCalledWith(linked);
    await act(async () =>
      paneButton()?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(choose).toHaveBeenLastCalledWith(linked, true);
    const tabButton = space?.querySelector<HTMLButtonElement>(".wb-disclosure");
    await act(async () => tabButton?.click());
    expect(tabButton?.getAttribute("aria-expanded")).toBe("false");
    expect(paneButton()).toBeNull();
    await act(async () => publish(true));
    expect(tabButton?.getAttribute("aria-expanded")).toBe("false");
    expect(space?.querySelector(".wb-status")?.textContent).toBe("◐");
    await act(async () => render("cdx"));
    expect(paneButton()).not.toBeNull();
    expect(element.querySelector('[aria-label="research"]')).toBeNull();
    await act(async () => render());
    expect(paneButton()).toBeNull();
    expect(
      element.querySelector('[aria-label="research"] .wb-tree-pane'),
    ).not.toBeNull();
    const spaceButton = space?.querySelector<HTMLButtonElement>(".wb-space");
    await act(async () => spaceButton?.click());
    expect(spaceButton?.getAttribute("aria-expanded")).toBe("false");
    expect(space?.querySelector(".wb-tree-tab")).toBeNull();
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>('[title="Open Main terminal"]')
        ?.click(),
    );
    expect(openPinned).toHaveBeenCalledWith("main");
    // A second window gets fresh in-memory expansion state.
    const second = document.createElement("div");
    const secondRoot = createRoot(second);
    await act(async () =>
      secondRoot.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
          children: createElement(Sidebar, {
            filter: "",
            setFilter: vi.fn(),
            choose,
            openGroup: vi.fn(),
            hidePanels: vi.fn(),
            hasPanels: () => false,
            copyAttach: vi.fn(),
            newTerminal: vi.fn(),
            openPinned,
          }),
        }),
      ),
    );
    expect(
      second.querySelector(".wb-space")?.getAttribute("aria-expanded"),
    ).toBe("true");
    await act(async () => secondRoot.unmount());
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
