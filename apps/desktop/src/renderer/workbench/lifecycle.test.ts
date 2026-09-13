// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AckOutcome, PaneIdentity, PaneView } from "@loom/protocol";
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import {
  at,
  id,
  meta as protocolMeta,
} from "../../../../../packages/protocol/src/test-support.js";
import { defaultKeybindingsState } from "../../shared/keybindings.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Workbench } from "./workbench.js";

vi.mock("dockview", () => ({
  GridviewReact: () => null,
  Orientation: { HORIZONTAL: "horizontal" },
}));
vi.mock("../ui/lead.js", () => ({ LeadBar: () => null }));
const terminalRenders = vi.hoisted(() => vi.fn());
vi.mock("../ui/terminal.js", async () => {
  const { memo } = await import("react");
  return {
    TerminalSession: memo(({ pane }: { pane?: PaneIdentity }) => {
      terminalRenders();
      return createElement("div", { "data-attached-pane": pane?.paneId });
    }),
  };
});
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
    chooseRepository: vi.fn(),
    interactive: vi.fn(),
    keybindings: async () => defaultKeybindingsState,
    onKeybindingsChanged: () => () => {},
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
    await act(async () => h.button("Open Existing terminal sh %8").click());
    await act(async () => h.button("Open Existing terminal sh %8").click());
    expect(h.element.querySelector("dialog")).toBeNull();
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    // A native shell exit disappears even when tmux keeps a dead pane for diagnostics.
    await act(async () => {
      h.native.set(next.id, { ...next, dead: true });
      h.publish();
    });
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(0);
    expect(h.element.querySelector(".wb-terminal-list")?.textContent).toContain(
      "Existing terminal",
    );
    expect(h.button("Open Existing terminal sh %8").disabled).toBe(true);
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
    expect(h.button("Open shell sh %2").disabled).toBe(true);
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

test("pane clicks replace the focused viewer, Enter opens an independent tab, and patches preserve terminals", async () => {
  const next = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%8"]),
    paneId: "%8",
    windowId: "@8",
    windowName: "Build",
  };
  const h = await harness([pane, next]);
  try {
    await act(async () => h.button("Open Build sh %8").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%8");
    await act(async () =>
      h.button("Open Build sh %8").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(2);
    expect(h.send).not.toHaveBeenCalled();
    const renders = terminalRenders.mock.calls.length;
    await act(async () => {
      h.native.set(next.id, { ...next, attention: true, status: "blocked" });
      h.publish();
    });
    expect(h.element.querySelector(".wb-space .wb-status")?.textContent).toBe(
      "●",
    );
    expect(terminalRenders).toHaveBeenCalledTimes(renders);
    await act(async () => {
      h.native.set(pane.id, { ...pane, branch: "feat/branch-patch" });
      h.native.set(next.id, { ...next, branch: "feat/branch-patch" });
      h.publish();
    });
    expect(h.element.querySelector(".wb-space-branch")?.textContent).toBe(
      "feat/branch-patch",
    );
    expect(terminalRenders).toHaveBeenCalledTimes(renders);
  } finally {
    await h.close();
  }
});

const contextMenu = async (button: HTMLElement) => {
  await act(async () =>
    button.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    ),
  );
};

test("tab rows open all live siblings as independent splits despite filtering; menu close only detaches this tab", async () => {
  const sibling = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%8"]),
    paneId: "%8",
    command: "unique",
  };
  const dead = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%9"]),
    paneId: "%9",
    dead: true,
  };
  const unavailable = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%10"]),
    paneId: "%10",
    unavailable: true,
  };
  const h = await harness([pane, sibling, dead, unavailable]);
  try {
    const filter = h.element.querySelector<HTMLInputElement>("#agent-filter");
    if (!filter) throw new Error("Missing filter");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(filter, "unique");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      h.element.querySelectorAll(".wb-tree-pane[data-pane-key]"),
    ).toHaveLength(1);
    await act(async () => h.button("Open tab shell").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(3);
    const grids = h.element.querySelectorAll(".wb-tab");
    expect(grids).toHaveLength(2);
    expect(
      [...(grids[1]?.querySelectorAll("[data-attached-pane]") ?? [])].map((p) =>
        p.getAttribute("data-attached-pane"),
      ),
    ).toEqual(["%2", "%8"]);
    expect(h.send).not.toHaveBeenCalled();
    const renders = terminalRenders.mock.calls.length;
    await act(async () => {
      h.native.set(sibling.id, {
        ...sibling,
        status: "working",
        branch: "feat/update",
      });
      h.publish();
    });
    expect(terminalRenders).toHaveBeenCalledTimes(renders);
    await contextMenu(h.button("Open tab shell"));
    expect(h.button("Rename").disabled).toBe(true);
    await act(async () => h.button("Close panel").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(h.native.size).toBe(4);
    expect(h.send).not.toHaveBeenCalled();
    await contextMenu(h.button("Open tab shell"));
    await act(async () => h.button("Open in new tab").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(3);
  } finally {
    await h.close();
  }
});

test("pane menu opens, copies the coordinator attach argv safely, and closes just its viewer", async () => {
  const sibling = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%8"]),
    paneId: "%8",
    command: "unique",
  };
  const h = await harness([pane, sibling]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockImplementation(writeText);
  try {
    await contextMenu(h.button("Open shell unique %8"));
    await act(async () => h.button("Open").click());
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%8");
    await contextMenu(h.button("Open shell unique %8"));
    await act(async () => h.button("Open in new tab").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(2);
    await contextMenu(h.button("Open shell unique %8"));
    h.send.mockResolvedValueOnce({
      ok: true,
      result: {
        kind: "attach_session",
        target: {
          identity: "pane",
          target: sibling,
          pane: {
            ...sibling,
            size: null,
            observedAt: at("2026-09-13T00:00:00.000Z"),
          },
          attach: {
            kind: "pane_host",
            cwd: id.worktree("/tmp"),
            env: { TMUX_TMPDIR: "/tmp/private space" },
            argv: [
              "tmux",
              "-L",
              "loom-test",
              "attach-session",
              "-t",
              "research'quoted",
            ],
          },
        },
      },
    });
    await act(async () => h.button("Copy attach command").click());
    expect(h.send).toHaveBeenLastCalledWith({
      kind: "open_pane_session",
      target: {
        hostGeneration: sibling.hostGeneration,
        sessionName: sibling.sessionName,
        windowId: sibling.windowId,
        paneId: sibling.paneId,
      },
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      `'env' 'TMUX_TMPDIR=/tmp/private space' 'tmux' '-L' 'loom-test' 'attach-session' '-t' 'research'"'"'quoted'`,
    );
    await contextMenu(h.button("Open shell unique %8"));
    await act(async () => h.button("Close panel").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(h.native.size).toBe(2);
    expect(h.send).toHaveBeenCalledTimes(1);
    // Keyboard opening and Escape restore the row without triggering Workbench bindings.
    await act(async () =>
      h.button("Open shell unique %8").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(h.element.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(h.element.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(h.button("Open shell unique %8"));
  } finally {
    clipboard.mockRestore();
    await h.close();
  }
});

test("menu tracks unavailable inventory, retains viewer-only close, and reports copy failures", async () => {
  const h = await harness();
  const clipboard = vi.spyOn(navigator.clipboard, "writeText");
  try {
    await contextMenu(h.button("Open shell sh %2"));
    h.send.mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "Pane is stale", details: [] },
    });
    await act(async () => h.button("Copy attach command").click());
    expect(clipboard).not.toHaveBeenCalled();
    expect(h.element.querySelector('[role="alert"]')?.textContent).toContain(
      "Pane is stale",
    );
    await contextMenu(h.button("Open tab shell"));
    await act(async () => {
      h.native.set(pane.id, { ...pane, unavailable: true });
      h.publish();
    });
    expect(h.button("Open").disabled).toBe(true);
    expect(h.button("Open in new tab").disabled).toBe(true);
    expect(h.button("Copy attach command").disabled).toBe(true);
    expect(h.button("Close panel").disabled).toBe(false);
    await act(async () => h.button("Close panel").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(0);
    expect(h.native.size).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  } finally {
    clipboard.mockRestore();
    await h.close();
  }
});

test("rename patches keep viewers mounted and close uses the current session name", async () => {
  const h = await harness();
  try {
    const count = terminalRenders.mock.calls.length;
    const viewer = h.element.querySelector("[data-attached-pane]");
    h.native.set(pane.id, {
      ...pane,
      sessionName: "Renamed space",
      windowName: "Renamed tab",
    });
    await act(async () => h.publish());
    expect(h.element.querySelector("[data-attached-pane]")).toBe(viewer);
    expect(terminalRenders).toHaveBeenCalledTimes(count);
    expect(h.element.querySelector('[title="Renamed space"]')).not.toBeNull();
    const close = h.element.querySelector<HTMLButtonElement>(
      '[aria-label="Close terminal"]',
    );
    if (!close) throw new Error("Missing close terminal");
    await act(async () => close.click());
    expect(h.send).toHaveBeenCalledWith({
      kind: "close_terminal",
      target: {
        hostGeneration: pane.hostGeneration,
        sessionName: "Renamed space",
        windowId: pane.windowId,
        paneId: pane.paneId,
      },
    });
  } finally {
    await h.close();
  }
});
