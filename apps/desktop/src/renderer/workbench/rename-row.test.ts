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
  const store = createStore(undefined, "test");
  const linked = {
    ...pane,
    taskId: "t-1" as TaskId,
    taskName: "Keep task title",
    issueKey: "LOOM-1",
    taskStage: "in_progress" as const,
    agent: "claude" as const,
  };
  const publish = (
    spaceTitle: string | null = null,
    tabTitle: string | null = null,
    paneTitle: string | null = null,
  ) =>
    store.applyProtocol(
      stateFromSnapshot(meta, {
        ...emptySnapshotBody(),
        panes: [{ ...linked, spaceTitle, tabTitle, paneTitle }],
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
            choose: vi.fn(),
            openGroup: vi.fn(),
            hidePanels: vi.fn(),
            copyAttach: vi.fn(),
            openPinned: vi.fn(),
          }),
        }),
      ),
    );
    await key(element.querySelector(".wb-space") as Element, "F2");
    expect(input().value).toBe("Keep task title");
    expect(document.activeElement).toBe(input());
    await change("x".repeat(81));
    await submit();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "80 characters",
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
      kind: "set_title",
      hostGeneration: pane.hostGeneration,
      target: { kind: "space", sessionId: pane.sessionId },
      title: "New space",
    });
    await act(async () =>
      resolve({
        ok: false,
        error: { code: "internal", message: "title failed", details: [] },
      }),
    );
    expect(input().value).toBe("New space");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "title failed",
    );
    await change("Accepted space");
    await submit();
    await act(async () => resolve({ ok: true, result: { kind: "titled" } }));
    expect(input()).toBeNull();
    expect(element.querySelector(".wb-space")?.getAttribute("title")).toBe(
      "Keep task title",
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
      kind: "set_title",
      hostGeneration: pane.hostGeneration,
      target: { kind: "tab", windowId: pane.windowId },
      title: "Tab: v2.0",
    });
    await act(async () => {
      publish("Accepted space", "Tab: v2.0");
      resolve({ ok: true, result: { kind: "titled" } });
    });
    expect(
      element.querySelector(".wb-tab-row > .wb-tree-row")?.textContent,
    ).toContain("Tab: v2.0");
    await key(element.querySelector(".wb-agent-list button") as Element, "F2");
    await change("My agent");
    await submit();
    expect(send).toHaveBeenLastCalledWith({
      kind: "set_title",
      hostGeneration: pane.hostGeneration,
      target: { kind: "pane", paneId: pane.paneId },
      title: "My agent",
    });
    await act(async () => {
      publish("Accepted space", "Tab: v2.0", "My agent");
      resolve({ ok: true, result: { kind: "titled" } });
    });
    expect(element.querySelector(".wb-agent-list strong")?.textContent).toBe(
      "My agent",
    );
    expect(
      element
        .querySelector(".wb-agent-list .wb-status")
        ?.getAttribute("aria-label"),
    ).toBe("Idle");
    await key(element.querySelector(".wb-agent-list button") as Element, "F2");
    await change("");
    await submit();
    expect(send).toHaveBeenLastCalledWith({
      kind: "set_title",
      hostGeneration: pane.hostGeneration,
      target: { kind: "pane", paneId: pane.paneId },
      title: "",
    });
    await act(async () => resolve({ ok: true, result: { kind: "titled" } }));
    expect(send).toHaveBeenCalledTimes(5);

    for (const [selector, kind] of [
      [".wb-space", "space"],
      [".wb-tab-row > .wb-tree-row", "tab"],
      [".wb-agent-list button", "pane"],
    ] as const) {
      await act(async () =>
        element.querySelector(selector)?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      const rename = [
        ...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ].find((item) => item.textContent === "Rename");
      expect(rename?.disabled).toBe(false);
      await act(async () => rename?.click());
      expect(input().getAttribute("aria-label")).toBe(`Rename ${kind}`);
      await key(input(), "Escape");
    }
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
