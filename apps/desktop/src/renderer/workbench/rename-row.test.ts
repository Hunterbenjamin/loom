// @vitest-environment happy-dom
import type { TaskId } from "@loom/core";
import {
  type AckOutcome,
  emptySnapshotBody,
  stateFromSnapshot,
} from "@loom/protocol";
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

test("inline rename validates, cancels, reports errors and waits for native patches", async () => {
  const store = createStore(undefined, true, "test");
  const linked = {
    ...pane,
    taskId: "t-1" as TaskId,
    taskName: "Keep task title",
    issueKey: "LOOM-1",
    taskStage: "in_progress" as const,
  };
  const publish = (
    sessionName = pane.sessionName,
    windowName = pane.windowName,
  ) =>
    store.applyProtocol(
      stateFromSnapshot(meta, {
        ...emptySnapshotBody(),
        panes: [{ ...linked, sessionName, windowName }],
      }),
    );
  publish();
  window.loomHost = {
    interactive: vi.fn(),
  } as unknown as typeof window.loomHost;
  let resolve: (result: AckOutcome) => void = () => {};
  const send = vi.fn(
    () =>
      new Promise<AckOutcome>((done) => {
        resolve = done;
      }),
  );
  store.setSender(send);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const input = () =>
    element.querySelector<HTMLInputElement>(
      ".wb-rename input",
    ) as HTMLInputElement;
  const key = async (target: Element, key: string) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  const change = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const submit = async () =>
    act(async () => {
      element
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  try {
    await act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
          children: createElement(Sidebar, {
            filter: "",
            setFilter: vi.fn(),
            choose: vi.fn(),
            openGroup: vi.fn(),
            hidePanels: vi.fn(),
            copyAttach: vi.fn(),
            hasPanels: () => false,
            newTerminal: vi.fn(),
            openPinned: vi.fn(),
          }),
        }),
      ),
    );
    await key(element.querySelector(".wb-space") as Element, "F2");
    expect(input().value).toBe("research");
    expect(document.activeElement).toBe(input());
    await change("bad.name");
    await submit();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot contain . or :",
    );
    expect(send).not.toHaveBeenCalled();
    await key(input(), "Escape");
    expect(input()).toBeNull();
    expect(element.textContent).toContain(linked.taskName);
    await act(async () =>
      element
        .querySelector(".wb-space")
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    await change("New space");
    await submit();
    await submit();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      kind: "rename_space",
      hostGeneration: pane.hostGeneration,
      sessionId: pane.sessionId,
      name: "New space",
    });
    await act(async () =>
      resolve({
        ok: false,
        error: { code: "internal", message: "duplicate session", details: [] },
      }),
    );
    expect(input().value).toBe("New space");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "duplicate session",
    );
    await change("Accepted space");
    await submit();
    await act(async () => resolve({ ok: true, result: { kind: "renamed" } }));
    expect(input()).toBeNull();
    expect(element.querySelector(".wb-space")?.getAttribute("title")).toBe(
      "research",
    );
    await act(async () => publish("Accepted space"));
    expect(element.querySelector(".wb-space")?.getAttribute("title")).toBe(
      "Accepted space",
    );
    expect(element.textContent).toContain(linked.taskName);
    await key(
      element.querySelector(".wb-tab-row > .wb-tree-row") as Element,
      "F2",
    );
    await change("Tab: v2.0");
    await submit();
    expect(send).toHaveBeenLastCalledWith({
      kind: "rename_tab",
      hostGeneration: pane.hostGeneration,
      windowId: pane.windowId,
      name: "Tab: v2.0",
    });
    await act(async () => {
      publish("Accepted space", "Tab: v2.0");
      resolve({ ok: true, result: { kind: "renamed" } });
    });
    expect(
      element.querySelector(".wb-tab-row > .wb-tree-row")?.textContent,
    ).toContain("Tab: v2.0");
    await key(
      element.querySelector(".wb-tab-row > .wb-tree-row") as Element,
      "F2",
    );
    await change("Canceled tab");
    await key(input(), "Escape");
    expect(
      element.querySelector(".wb-tab-row > .wb-tree-row")?.textContent,
    ).toContain("Tab: v2.0");
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
