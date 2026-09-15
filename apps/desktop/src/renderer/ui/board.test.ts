// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { selectedRows } from "../store/selectors.js";
import { BoardView } from "./board.js";

const scroll = vi.fn();
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 84,
    getVirtualItems: () => [],
    scrollToIndex: scroll,
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("board scrolls for a different selected task, not refreshed rows or virtualizers", () => {
  const store = createFixtureStore(buildSnapshot(20));
  store.setPane("board");
  store.setCursor(0);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: typed provider children
          children: createElement(BoardView),
        }),
      ),
    );
    expect(scroll).toHaveBeenCalledOnce();
    scroll.mockClear();
    act(() => {
      store.getState().snapshot = structuredClone(store.getState().snapshot);
      store.setCursor(0);
    });
    expect(scroll).not.toHaveBeenCalled();
    expect(selectedRows(store.getState()).length).toBeGreaterThan(1);
    act(() => store.setCursor(1));
    expect(scroll).toHaveBeenCalledOnce();
    scroll.mockClear();
    act(() => store.setCursor(null));
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
