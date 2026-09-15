// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { inboxRows } from "../store/inbox.js";
import { StoreProvider } from "../store/react.js";
import { cursorRows, selectedRows } from "../store/selectors.js";
import { createShortcutHandler } from "./keys.js";
import { TrackerFilter } from "./list-rows.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("the shared filter focuses with slash and filters Issues list, board and Inbox", () => {
  const store = createFixtureStore(buildSnapshot(20));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: typed provider children
          children: createElement(TrackerFilter),
        }),
      ),
    );
    const handler = createShortcutHandler(store);
    const input = host.querySelector("input");
    for (const view of ["all", "needs-you", "briefs"] as const) {
      act(() => store.setView(view));
      handler(new KeyboardEvent("keydown", { key: "/" }));
      expect(document.activeElement).toBe(input);
      input?.blur();
    }
    act(() => {
      store.setView("all");
      store.setFilterQuery("no-such-issue-xyz");
    });
    expect(selectedRows(store.getState())).toEqual([]);
    expect(cursorRows(store.getState())).toEqual([]);
    act(() => store.setPane("board"));
    expect(cursorRows(store.getState())).toEqual([]);
    act(() => store.setView("needs-you"));
    expect(inboxRows(store.getState())).toEqual([]);
    act(() => store.setFilterQuery(""));
    expect(inboxRows(store.getState()).length).toBeGreaterThan(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
