// @vitest-environment happy-dom
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { pane } from "../../../../../packages/protocol/src/pane-fixture.js";
import {
  meta,
  snapshot,
} from "../../../../../packages/protocol/src/test-support.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { Sidebar } from "./sidebar.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("renders spaces and agents, always-expanded tabs, filtering and pinned controls", async () => {
  const store = createStore(undefined, true, "test");
  const linked = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%3"]),
    paneId: "%3",
    sessionName: "loom-t-1",
    sessionId: "$2",
    windowName: "implementer",
    taskName: "Fix delivery race",
    issueKey: "LOOM-1",
    taskStage: "in_progress" as const,
    branch: "fix/delivery-race",
    role: "implementer",
    provider: "codex",
    status: "working",
  };
  const publish = (attention = false) =>
    store.applyProtocol(
      stateFromSnapshot(meta, {
        ...emptySnapshotBody(),
        repos: snapshot().repos,
        projects: snapshot().projects,
        panes: [pane, { ...linked, attention }],
      }),
    );
  publish();
  window.loomHost = {
    chooseRepository: vi.fn(),
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
          selected: linked,
          choose,
          openGroup: vi.fn(),
          hidePanels: vi.fn(),
          copyAttach: vi.fn(),
          openPinned,
        }),
      }),
    );
  try {
    await act(async () => render());
    const space = element.querySelector<HTMLElement>(
      '[aria-label="Fix delivery race"]',
    );
    expect(space?.textContent).toContain("Implementer");
    expect(space?.querySelectorAll(".wb-tree-pane")).toHaveLength(0);
    expect(
      [...element.querySelectorAll(".wb-terminal-list .wb-tree-row")].map(
        (row) => ({
          name: row.getAttribute("aria-label"),
          text: row.querySelector(".wb-tree-name")?.textContent,
          branch: row.querySelector(".wb-space-branch")?.textContent ?? null,
        }),
      ),
    ).toMatchSnapshot();
    // The space row keeps a plain circle; its first tab carries the live indicator.
    expect(space?.querySelector(".wb-status")?.textContent).toBe("○");
    expect(
      space
        ?.querySelector(".wb-tab-row .wb-status")
        ?.getAttribute("aria-label"),
    ).toBe("Working");
    expect(space?.querySelector(".wb-space-branch")?.textContent).toBe(
      "LOOM-1 · in progress",
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
    expect(
      [...element.querySelectorAll(".wb-section-heading h2")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["spaces", "agents"]);
    expect(
      element.querySelector(".wb-agents .wb-pinned")?.nextElementSibling
        ?.className,
    ).toBe("wb-agent-list");
    const agent = element.querySelector<HTMLButtonElement>(
      ".wb-agent-list button",
    );
    expect(agent?.textContent).toContain(
      "implementer · codexFix delivery race · codex",
    );
    expect(agent?.querySelector("small")?.textContent).toBe(
      "Fix delivery race · codex",
    );
    expect(agent?.getAttribute("aria-current")).toBe("true");
    expect(
      space?.querySelector(".wb-space")?.getAttribute("aria-current"),
    ).toBe("true");
    await act(async () => agent?.click());
    expect(choose).toHaveBeenLastCalledWith(linked);
    await act(async () =>
      agent?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(choose).toHaveBeenLastCalledWith(linked, true);
    const grouped = element.querySelector<HTMLButtonElement>(
      '[aria-label="Group agents by space"]',
    );
    await act(async () => grouped?.click());
    expect(grouped?.getAttribute("aria-pressed")).toBe("false");
    // The sidebar can't be collapsed: no toggle anywhere.
    expect(element.querySelector('[aria-label="Collapse sidebar"]')).toBeNull();
    expect(element.querySelector(".wb-sidebar-footer")).toBeNull();
    expect(element.querySelector(".wb-spaces-footer")).toBeNull();
    expect(element.querySelector("#agent-filter")).toBeNull();
    // Spaces are never collapsible: their tabs are always shown.
    expect(space?.querySelector(".wb-disclosure")).toBeNull();
    expect(space?.querySelector(".wb-tree-tab")).not.toBeNull();
    await act(async () => publish(true));
    expect(space?.querySelector(".wb-status")?.textContent).toBe("○");
    expect(space?.querySelector(".wb-tab-row .wb-status")?.textContent).toBe(
      "●",
    );
    await act(async () => render("cdx"));
    expect(space?.querySelector(".wb-tree-tab")).not.toBeNull();
    expect(element.querySelector('[aria-label="research"]')).toBeNull();
    await act(async () => render());
    expect(space?.querySelector(".wb-tree-tab")).not.toBeNull();
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>('[title="Open Main terminal"]')
        ?.click(),
    );
    expect(openPinned).toHaveBeenCalledWith("main");
    const openChat = vi.fn();
    window.addEventListener("loom:open-chat", openChat, { once: true });
    const main = element.querySelector<HTMLButtonElement>(
      '[title="Open Main terminal"]',
    );
    await act(async () =>
      main?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      ),
    );
    await act(async () =>
      [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent === "Open as chat")
        ?.click(),
    );
    expect(openChat).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { kind: "lead", repoId: snapshot().repos[0]?.id },
      }),
    );
    // A second window shows the same always-expanded tree.
    const second = document.createElement("div");
    const secondRoot = createRoot(second);
    await act(async () =>
      secondRoot.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
          children: createElement(Sidebar, {
            filter: "",
            choose,
            openGroup: vi.fn(),
            hidePanels: vi.fn(),
            copyAttach: vi.fn(),
            openPinned,
          }),
        }),
      ),
    );
    expect(second.querySelector(".wb-disclosure")).toBeNull();
    expect(second.querySelector(".wb-tree-tab")).not.toBeNull();
    await act(async () => secondRoot.unmount());
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test("grouping changes agent order, keeps dead agents out of the list, and leaves the tree alone", async () => {
  const store = createStore(undefined, true, "test");
  const agents = [
    {
      ...pane,
      id: "a",
      paneId: "%3",
      sessionName: "Alpha",
      provider: "codex",
      status: "idle",
    },
    {
      ...pane,
      id: "b",
      paneId: "%4",
      sessionName: "Alpha",
      provider: "claude",
      status: "ended",
      dead: true,
    },
    {
      ...pane,
      id: "c",
      paneId: "%5",
      sessionName: "Zebra",
      provider: "codex",
      status: "working",
    },
  ];
  store.applyProtocol(
    stateFromSnapshot(meta, { ...emptySnapshotBody(), panes: agents }),
  );
  window.loomHost = {
    interactive: vi.fn(),
  } as unknown as typeof window.loomHost;
  const element = document.createElement("div");
  const root = createRoot(element);
  const choose = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
          children: createElement(Sidebar, {
            filter: "",
            choose,
            openGroup: vi.fn(),
            hidePanels: vi.fn(),
            copyAttach: vi.fn(),
            openPinned: vi.fn(),
          }),
        }),
      ),
    );
    const rows = () => [
      ...element.querySelectorAll<HTMLButtonElement>(".wb-agent-list button"),
    ];
    // The dead pane is being reaped by the host: it is not an agent row at all.
    expect(
      rows().map((row) => row.querySelector(".wb-status")?.textContent),
    ).toEqual(["○", expect.stringMatching(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/)]);
    expect(element.querySelector(".wb-agent-list .dead")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
    const treeBefore = [
      ...element.querySelectorAll(".wb-space .wb-tree-name"),
    ].map((row) => row.textContent);
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>(
          '[aria-label="Group agents by space"]',
        )
        ?.click(),
    );
    expect(
      rows().map((row) =>
        row.querySelector(".wb-status")?.getAttribute("aria-label"),
      ),
    ).toEqual(["Working", "Idle"]);
    expect(
      [...element.querySelectorAll(".wb-space .wb-tree-name")].map(
        (row) => row.textContent,
      ),
    ).toEqual(treeBefore);
    expect(
      [...element.querySelectorAll(".wb-pinned strong")].map(
        (row) => row.textContent,
      ),
    ).toEqual(["Main"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test.each([false, true])(
  "pins workbench sessions with dev controls available=%s",
  async (available) => {
    const store = createStore(undefined, true, "test");
    const coordinator = {
      ...pane,
      id: "coordinator",
      paneId: "%20",
      sessionId: "$20",
      sessionName: "loom-coordinator",
      windowName: "coordinator",
      status: "working",
    };
    const desktop = {
      ...pane,
      id: "desktop",
      paneId: "%21",
      sessionId: "$21",
      sessionName: "loom-desktop",
      windowName: "desktop",
    };
    const publish = (panes: (typeof pane)[]) =>
      store.applyProtocol(
        stateFromSnapshot(meta, { ...emptySnapshotBody(), panes }),
      );
    publish([pane, coordinator, desktop]);
    const devControl = vi.fn().mockResolvedValue(undefined);
    window.loomHost = {
      devControlAvailable: vi.fn().mockResolvedValue(available),
      devControl,
      interactive: vi.fn(),
    } as unknown as typeof window.loomHost;
    const element = document.createElement("div");
    const root = createRoot(element);
    const openGroup = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(StoreProvider, {
            store,
            // biome-ignore lint/correctness/noChildrenProp: Provider requires typed children.
            children: createElement(Sidebar, {
              filter: "",
              choose: vi.fn(),
              openGroup,
              hidePanels: vi.fn(),
              copyAttach: vi.fn(),
              openPinned: vi.fn(),
            }),
          }),
        ),
      );
      expect(
        [...element.querySelectorAll(".wb-terminal-list .wb-tree-name")].map(
          (row) => row.textContent,
        ),
      ).not.toEqual(expect.arrayContaining(["Coordinator", "Desktop"]));
      expect(element.querySelectorAll(".wb-agent-list button")).toHaveLength(0);
      const fixed = element.querySelector(".wb-workbench-sessions");
      expect(fixed?.nextElementSibling).toBeNull();
      expect(
        [...(fixed?.querySelectorAll("button") ?? [])].map(
          (row) => row.textContent,
        ),
      ).toEqual([
        expect.stringContaining("Coordinator"),
        expect.stringContaining("Desktop"),
      ]);
      const coordinatorRow = fixed?.querySelector<HTMLButtonElement>(
        '[aria-label="Open Coordinator terminal"]',
      );
      expect(
        coordinatorRow?.querySelector(".wb-status")?.getAttribute("aria-label"),
      ).toBe("Working");
      await act(async () => coordinatorRow?.click());
      expect(openGroup).toHaveBeenCalledWith([coordinator], "loom-coordinator");

      for (const [name, restart, command] of [
        ["Coordinator", "Restart coordinator", "restart-coordinator"],
        ["Desktop", "Restart app", "restart-app"],
      ]) {
        const row = fixed?.querySelector<HTMLButtonElement>(
          `[aria-label="Open ${name} terminal"]`,
        );
        const openMenu = () =>
          act(async () => {
            row?.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        await openMenu();
        const items = () => [
          ...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        ];
        expect(items().some((item) => item.textContent === restart)).toBe(
          available,
        );
        expect(
          items().some((item) => item.textContent === "Sync dev instance"),
        ).toBe(available);
        expect(
          items().some(
            (item) =>
              item.textContent ===
              (name === "Coordinator" ? "Restart app" : "Restart coordinator"),
          ),
        ).toBe(false);
        if (available) {
          await act(async () =>
            items()
              .find((item) => item.textContent === restart)
              ?.click(),
          );
          expect(devControl).toHaveBeenLastCalledWith(command);
          await openMenu();
          await act(async () =>
            items()
              .find((item) => item.textContent === "Sync dev instance")
              ?.click(),
          );
          expect(devControl).toHaveBeenLastCalledWith("sync");
        }
      }
      // Ordinary space menus never gain service actions, even in development.
      await act(async () =>
        element
          .querySelector(".wb-space")
          ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
      );
      expect(element.querySelector('[role="menu"]')?.textContent).not.toContain(
        "Sync dev instance",
      );
      expect(element.querySelector('[role="menu"]')?.textContent).not.toContain(
        "Restart coordinator",
      );
      if (!available) expect(devControl).not.toHaveBeenCalled();

      await act(async () => publish([pane, coordinator]));
      expect(
        element.querySelector('[aria-label="Open Desktop terminal"]'),
      ).toBeNull();
      await act(async () => publish([pane]));
      expect(element.querySelector(".wb-workbench-sessions")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
