// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AckOutcome, PaneIdentity, PaneView } from "@loom/protocol";
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import { meta as protocolMeta } from "../../../../../packages/protocol/src/test-support.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Workbench } from "./workbench.js";

vi.mock("dockview", () => ({
  GridviewReact: () => null,
  Orientation: { HORIZONTAL: "horizontal" },
}));
vi.mock("../ui/lead.js", () => ({ LeadBar: () => null }));
vi.mock("../ui/terminal.js", () => ({
  TerminalSession: ({ pane }: { pane?: PaneIdentity }) =>
    createElement("div", { "data-attached-pane": pane?.paneId }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function harness(initial: PaneView[] = [pane]) {
  const store = createStore(undefined, true, "test");
  const native = new Map(initial.map((p) => [p.id, p]));
  const publish = () =>
    store.applyProtocol(
      stateFromSnapshot(protocolMeta, {
        ...emptySnapshotBody(),
        panes: [...native.values()],
      }),
    );
  publish();
  store.setConnection("connected");
  window.loomHost = {
    interactive: vi.fn(),
  } as unknown as typeof window.loomHost;
  window.loom = { store, ready: true, diffPaintedAt: null, term: null };
  const send = vi.fn(async (command): Promise<AckOutcome> => {
    if (command.kind === "close_terminal") {
      native.delete(
        JSON.stringify([command.target.hostGeneration, command.target.paneId]),
      );
      publish();
      return {
        ok: true,
        result: { kind: "terminal_closed", target: command.target },
      };
    }
    if (command.kind === "open_workbench_terminal") {
      const created = {
        ...pane,
        id: JSON.stringify([pane.hostGeneration, "%99"]),
        paneId: "%99",
        windowId: "@99",
        windowName: command.label,
      };
      native.set(created.id, created);
      publish();
      return { ok: true, result: { kind: "scratch_created", pane: created } };
    }
    throw new Error(`Unexpected command: ${command.kind}`);
  });
  store.setSender(send);
  const element = document.createElement("div");
  document.body.append(element);
  let root = createRoot(element);
  const render = () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
        children: createElement(Workbench),
      }),
    );
  await act(async () => render());
  const button = (name: string) => {
    const b = [...element.querySelectorAll("button")].find(
      (b) =>
        b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
    );
    if (!b) throw new Error(`Missing button: ${name}`);
    return b;
  };
  return {
    store,
    native,
    publish,
    send,
    element,
    button,
    async remount() {
      await act(async () => root.unmount());
      root = createRoot(element);
      await act(async () => render());
    },
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

test("Workbench reserves a draggable title area and keeps tab controls interactive", async () => {
  const style = document.createElement("style");
  // happy-dom drops Electron's vendor property; retain its selectors for this
  // markup check. Native hit testing must also be verified in the running app.
  style.textContent = readFileSync(
    join(import.meta.dirname, "workbench.css"),
    "utf8",
  ).replaceAll("-webkit-app-region", "--test-app-region");
  document.head.append(style);
  const h = await harness();
  try {
    const titlebar = h.element.querySelector(".wb-titlebar");
    const tabs = h.element.querySelector(".wb-tabs");
    expect(titlebar).not.toBeNull();
    expect(tabs).not.toBeNull();
    if (!titlebar || !tabs) throw new Error("Missing window title area");
    expect(titlebar.nextElementSibling?.className).toBe("wb-body");
    expect(getComputedStyle(titlebar).height).toBe("30px");
    for (const region of [titlebar, tabs]) {
      expect(
        getComputedStyle(region).getPropertyValue("--test-app-region"),
      ).toBe("drag");
    }
    const controls = tabs.querySelectorAll("button");
    expect(controls.length).toBeGreaterThan(1);
    for (const control of controls) {
      expect(
        getComputedStyle(control).getPropertyValue("--test-app-region"),
      ).toBe("no-drag");
    }
    await act(async () => h.button("＋").click());
    expect(h.element.querySelector("dialog")).not.toBeNull();
  } finally {
    await h.close();
    style.remove();
  }
});

test("close ends the host terminal and removes its row; selecting from an empty Workbench only attaches", async () => {
  const h = await harness();
  try {
    expect(h.send).not.toHaveBeenCalled();
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    await act(async () => h.button("Close terminal").click());
    expect(h.send).toHaveBeenCalledExactlyOnceWith({
      kind: "close_terminal",
      target: {
        hostGeneration: pane.hostGeneration,
        sessionName: pane.sessionName,
        windowId: pane.windowId,
        paneId: pane.paneId,
      },
    });
    expect(
      h.element.querySelector(".wb-terminal-list")?.textContent,
    ).not.toContain("shell");
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(0);
    await h.remount();
    expect(h.send).toHaveBeenCalledTimes(1);
    const next = {
      ...pane,
      paneId: "%8",
      id: JSON.stringify([pane.hostGeneration, "%8"]),
      windowName: "Existing terminal",
    };
    await act(async () => {
      h.native.set(next.id, next);
      h.publish();
    });
    await act(async () => h.button("⌁Existing terminal").click());
    await act(async () => h.button("⌁Existing terminal").click());
    expect(h.element.querySelector("dialog")).toBeNull();
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    // A native shell exit disappears even when tmux keeps a dead pane for diagnostics.
    await act(async () => {
      h.native.set(next.id, { ...next, dead: true });
      h.publish();
    });
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(0);
    expect(
      h.element.querySelector(".wb-terminal-list")?.textContent,
    ).not.toContain("Existing terminal");
  } finally {
    await h.close();
  }
});

test("failed close retains the terminal and explains failure; unavailable inventory does not delete it", async () => {
  const h = await harness();
  try {
    h.send.mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "Host unavailable", details: [] },
    });
    await act(async () => h.button("Close terminal").click());
    expect(h.element.querySelector("[role=alert]")?.textContent).toContain(
      "Host unavailable",
    );
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    await act(async () => {
      h.native.set(pane.id, { ...pane, unavailable: true });
      h.publish();
    });
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(h.button("⌁shell").disabled).toBe(true);
  } finally {
    await h.close();
  }
});

test("New terminal creates once before attachment and remount never recreates it", async () => {
  const h = await harness([]);
  try {
    expect(h.send).not.toHaveBeenCalled();
    await act(async () => h.button("New terminal").click());
    expect(h.element.querySelector("dialog")).not.toBeNull();
    expect(h.send).not.toHaveBeenCalled();
    await act(async () =>
      h.element
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({
      kind: "open_workbench_terminal",
      label: "Terminal 1",
    });
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%99");
    await h.remount();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%99");
  } finally {
    await h.close();
  }
});
