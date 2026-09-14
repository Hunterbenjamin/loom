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
  snapshot,
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
    TerminalSession: memo(
      ({ pane, viewport }: { pane?: PaneIdentity; viewport?: unknown }) => {
        terminalRenders();
        return createElement("div", {
          "data-attached-pane": pane?.paneId,
          "data-viewport": JSON.stringify(viewport),
        });
      },
    ),
  };
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function harness(
  initial: PaneView[] = [pane],
  leadInventoryAfterAck = false,
  repoSelected = true,
) {
  const store = createStore(undefined, true, "test");
  const fixture = snapshot();
  const firstRepo = fixture.repos[0];
  if (!firstRepo) throw new Error("Missing fixture repository");
  const repos = [
    firstRepo,
    { ...firstRepo, id: id.repo("repo-other"), github: "you/other" },
  ];
  let selectedRepo = firstRepo.id;
  const native = new Map(initial.map((p) => [p.id, p]));
  const publish = () =>
    store.applyProtocol(
      stateFromSnapshot(protocolMeta, {
        ...emptySnapshotBody(),
        repos,
        projects: repoSelected ? [{ id: "project", repoId: selectedRepo }] : [],
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
      const source = command.target
        ? ([...native.values()].find(
            (p) => p.paneId === command.target.paneId,
          ) ?? pane)
        : pane;
      const created = {
        ...source,
        id: JSON.stringify([pane.hostGeneration, "%99"]),
        paneId: "%99",
        windowId: command.split ? source.windowId : "@99",
        windowName: command.split ? source.windowName : command.label,
        ...(command.workspace
          ? { sessionName: command.workspace, sessionId: "$99" }
          : {}),
      };
      native.set(created.id, created);
      publish();
      // Like the coordinator: a created terminal is acknowledged as a pane to attach.
      return {
        ok: true,
        result: {
          kind: "attach_session",
          target: {
            identity: "pane",
            target: {
              hostGeneration: created.hostGeneration,
              sessionName: created.sessionName,
              windowId: created.windowId,
              paneId: created.paneId,
            },
            attach: {
              kind: "pane_host",
              argv: ["tmux"],
              cwd: created.startCwd,
              env: {},
            },
            pane: {
              hostGeneration: created.hostGeneration,
              sessionName: created.sessionName,
              windowId: created.windowId,
              paneId: created.paneId,
              dead: false,
              exitStatus: null,
              attachedClients: 0,
              size: null,
              observedAt: at("2026-09-13T00:00:00.000Z"),
            },
          },
        },
      };
    }
    if (command.kind === "open_lead_session") {
      const sessionName = `loom-lead-${command.repoId}`;
      const suffix = command.repoId === firstRepo.id ? "77" : "78";
      const existing = [...native.values()].find(
        (candidate) => candidate.sessionName === sessionName,
      );
      const lead =
        existing ??
        ({
          ...pane,
          id: JSON.stringify([pane.hostGeneration, `%${suffix}`]),
          paneId: `%${suffix}`,
          windowId: `@${suffix}`,
          sessionName,
          sessionId: `$${suffix}`,
          windowName: "Main native",
          provider: "claude",
        } satisfies PaneView);
      if (leadInventoryAfterAck)
        setTimeout(() => {
          native.set(lead.id, lead);
          publish();
        });
      else {
        native.set(lead.id, lead);
        publish();
      }
      return {
        ok: true,
        result: {
          kind: "attach_session",
          target: {
            identity: "lead",
            repoId: command.repoId,
            sessionId: id.session(
              `00000000-0000-4000-8000-0000000000${suffix}`,
            ),
            attach: {
              kind: "pane_host",
              argv: ["tmux"],
              cwd: lead.startCwd,
              env: {},
            },
            pane: {
              hostGeneration: lead.hostGeneration,
              sessionName: lead.sessionName,
              windowId: lead.windowId,
              paneId: lead.paneId,
              dead: false,
              exitStatus: null,
              attachedClients: 0,
              size: null,
              observedAt: at("2026-09-13T00:00:00.000Z"),
            },
          },
        },
      };
    }
    if (command.kind === "select_repo") {
      selectedRepo = command.repoId;
      publish();
      return {
        ok: true,
        result: { kind: "repo_selected", repoId: command.repoId },
      };
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
    repos,
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
  style.textContent = [
    readFileSync(join(import.meta.dirname, "../theme.css"), "utf8"),
    readFileSync(join(import.meta.dirname, "workbench.css"), "utf8"),
  ]
    .join("\n")
    .replaceAll("-webkit-app-region", "--test-app-region");
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

test("panel labels prefer pane titles and fall back to tab titles", async () => {
  const titled = {
    ...pane,
    paneTitle: "Friendly agent",
    tabTitle: "Friendly tab",
  };
  const h = await harness([titled]);
  const label = () =>
    h.element.querySelector('[aria-label="Panel controls"]')?.textContent;
  try {
    expect(label()).toContain(`Friendly agent · ${pane.paneId}`);
    await act(async () => {
      h.native.set(titled.id, { ...titled, paneTitle: null });
      h.publish();
    });
    expect(label()).toContain(`Friendly tab · ${pane.paneId}`);
  } finally {
    await h.close();
  }
});

test("panel close kills the pane through the coordinator and drops its viewer", async () => {
  const h = await harness();
  try {
    await act(async () => h.button("Close panel").click());
    expect(h.send).toHaveBeenCalledExactlyOnceWith({
      kind: "close_terminal",
      target: {
        hostGeneration: pane.hostGeneration,
        sessionName: pane.sessionName,
        windowId: pane.windowId,
        paneId: pane.paneId,
      },
      scope: "pane",
    });
    expect(h.native.size).toBe(0);
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(0);
    expect(h.element.querySelector('[aria-label="Open tab shell"]')).toBeNull();
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

test("tab selection opens exactly its space, native windows in order and panes as splits", async () => {
  const build = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%8"]),
    paneId: "%8",
    windowId: "@8",
    windowIndex: 0,
    windowName: "Build",
    windowLayout: "abcd,120x40,0,0[120x20,0,0,8,120x19,0,21,9]",
    provider: "codex",
  };
  const sibling = {
    ...build,
    id: JSON.stringify([pane.hostGeneration, "%9"]),
    paneId: "%9",
    provider: null,
  };
  const other = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%12"]),
    paneId: "%12",
    sessionId: "$12",
    sessionName: "Other",
    windowName: "Other tab",
  };
  const h = await harness([{ ...pane, windowIndex: 3 }, build, sibling, other]);
  try {
    await act(async () => h.button("Open tab Build").click());
    expect(
      [...h.element.querySelectorAll(".wb-tabs button")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Build", "shell", "＋"]);
    const active = () =>
      h.element.querySelector<HTMLElement>('.wb-tab[style*="display: block"]');
    expect(
      [...(active()?.querySelectorAll("[data-attached-pane]") ?? [])].map((p) =>
        p.getAttribute("data-attached-pane"),
      ),
    ).toEqual(["%8", "%9"]);
    expect(h.element.querySelectorAll(".wb-tree-pane")).toHaveLength(0);
    expect(
      JSON.parse(
        active()
          ?.querySelector('[data-attached-pane="%9"]')
          ?.getAttribute("data-viewport") ?? "null",
      ),
    ).toEqual({
      columns: 120,
      rows: 40,
      left: 0,
      top: 21,
      width: 120,
      height: 19,
    });
    expect(h.button("Open space research").getAttribute("aria-current")).toBe(
      "true",
    );
    expect(
      h
        .button("Open tab Build")
        .closest(".wb-tab-row")
        ?.getAttribute("aria-current"),
    ).toBe("true");
    const viewer = active()?.querySelector("[data-attached-pane]");
    const renders = terminalRenders.mock.calls.length;
    await act(async () => {
      h.native.set(build.id, {
        ...build,
        attention: true,
        windowName: "Compile",
      });
      h.publish();
    });
    expect(active()?.querySelector("[data-attached-pane]")).toBe(viewer);
    expect(terminalRenders).toHaveBeenCalledTimes(renders);
    await act(async () => h.button("shell").click());
    expect(
      active()
        ?.querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%2");
    await act(async () => h.button("Open tab Other tab").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%12");
    await act(async () => h.button("Open agent research Compile %8").click());
    expect(active()?.querySelectorAll("[data-attached-pane]")).toHaveLength(2);
    await act(async () => h.button("Open space research").click());
    expect(h.button("Compile").getAttribute("aria-pressed")).toBe("true");
    expect(h.send).not.toHaveBeenCalled();
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

test("pane menu opens, copies the coordinator attach argv safely, and close kills the pane", async () => {
  const sibling = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%8"]),
    paneId: "%8",
    command: "unique",
    provider: "codex",
  };
  const h = await harness([pane, sibling]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockImplementation(writeText);
  try {
    await contextMenu(h.button("Open agent research shell %8"));
    await act(async () => h.button("Open").click());
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%2");
    await contextMenu(h.button("Open agent research shell %8"));
    await act(async () => h.button("Open space").click());
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(2);
    await contextMenu(h.button("Open agent research shell %8"));
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
    // Keyboard opening and Escape restore the row without triggering Workbench bindings.
    await act(async () =>
      h.button("Open agent research shell %8").dispatchEvent(
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
    expect(document.activeElement).toBe(
      h.button("Open agent research shell %8"),
    );
    // Close pane kills the row's process; the other viewer is untouched.
    await contextMenu(h.button("Open agent research shell %8"));
    await act(async () => h.button("Close pane").click());
    expect(h.send).toHaveBeenLastCalledWith({
      kind: "close_terminal",
      target: {
        hostGeneration: sibling.hostGeneration,
        sessionName: sibling.sessionName,
        windowId: sibling.windowId,
        paneId: sibling.paneId,
      },
      scope: "pane",
    });
    expect(h.native.size).toBe(1);
    expect(h.element.querySelectorAll("[data-attached-pane]")).toHaveLength(1);
  } finally {
    clipboard.mockRestore();
    await h.close();
  }
});

test("menu tracks unavailable inventory, disables close without live panes, and reports copy failures", async () => {
  const h = await harness();
  const clipboard = vi.spyOn(navigator.clipboard, "writeText");
  try {
    await contextMenu(h.button("Open tab shell"));
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
    expect(h.button("Open space").disabled).toBe(true);
    expect(h.button("Copy attach command").disabled).toBe(true);
    expect(h.button("Close tab").disabled).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  } finally {
    clipboard.mockRestore();
    await h.close();
  }
});

test("rename patches keep viewers mounted and close kills the pane", async () => {
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
    expect(h.button("Renamed tab")).toBeDefined();
    await act(async () => h.button("Close panel").click());
    expect(h.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "close_terminal", scope: "pane" }),
    );
  } finally {
    await h.close();
  }
});

test("new tab targets the selected space and split targets the active native window", async () => {
  const selected = { ...pane, sessionName: "Selected", sessionId: "$50" };
  const h = await harness([selected]);
  const submit = async () =>
    act(async () => {
      h.element
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  try {
    await act(async () => h.button("＋").click());
    await submit();
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({
      kind: "open_workbench_terminal",
      target: { sessionName: "Selected", paneId: "%2" },
    });
    expect(
      [...h.element.querySelectorAll(".wb-tabs button")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["shell", "Terminal 2", "＋"]);
    await act(async () => h.button("shell").click());
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(h.element.querySelector("dialog")).not.toBeNull();
    await submit();
    expect(h.send.mock.calls[1]?.[0]).toMatchObject({
      kind: "open_workbench_terminal",
      split: "below",
      target: { windowId: "@1", paneId: "%2" },
    });
    const active = h.element.querySelector('.wb-tab[style*="display: block"]');
    expect(active?.querySelectorAll("[data-attached-pane]")).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("a new space opens without a warning once the coordinator acknowledges the pane", async () => {
  const h = await harness([pane]);
  try {
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const input = h.element.querySelector<HTMLInputElement>("dialog input");
    if (!input) throw new Error("New space dialog did not open");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "Scratch work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      h.element
        .querySelector("dialog form, form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(h.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "open_workbench_terminal",
        workspace: "Scratch work",
      }),
    );
    expect(h.element.textContent).not.toContain("not confirmed");
    expect(h.element.querySelector("dialog")).toBeNull();
    expect(
      h.element.querySelector('[data-attached-pane*="%99"]'),
    ).not.toBeNull();
  } finally {
    await h.close();
  }
});

test("pinned Main resolves its repository target and ignores legacy-name decoys", async () => {
  const legacy = ["loom-main", "loom-lead"].map((sessionName, index) => ({
    ...pane,
    id: JSON.stringify([pane.hostGeneration, `%${80 + index}`]),
    paneId: `%${80 + index}`,
    sessionName,
    sessionId: `$${80 + index}`,
    windowName: `Legacy ${index}`,
  }));
  const h = await harness(legacy);
  try {
    const main = () =>
      h.element.querySelector<HTMLButtonElement>('[data-pinned="main"]');
    await act(async () => main()?.click());
    expect(h.send).toHaveBeenLastCalledWith({
      kind: "open_lead_session",
      repoId: snapshot().repos[0]?.id,
    });
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%77");
    expect(main()?.getAttribute("aria-current")).toBe("true");
    await act(async () => main()?.click());
    expect(
      h.send.mock.calls.filter(
        ([command]) => command.kind === "open_lead_session",
      ),
    ).toHaveLength(2);
    expect(
      [...h.native.values()].filter((candidate) =>
        candidate.sessionName.startsWith("loom-lead-"),
      ),
    ).toHaveLength(1);
    await act(async () => h.store.setRepo(h.repos[1]?.id ?? ""));
    await vi.waitFor(() =>
      expect(
        h.element
          .querySelector("[data-attached-pane]")
          ?.getAttribute("data-attached-pane"),
      ).toBe("%78"),
    );
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%78");
    await act(async () => h.store.setRepo(h.repos[0]?.id ?? ""));
    await vi.waitFor(() =>
      expect(
        h.element
          .querySelector("[data-attached-pane]")
          ?.getAttribute("data-attached-pane"),
      ).toBe("%77"),
    );
    expect(
      h.element
        .querySelector("[data-attached-pane]")
        ?.getAttribute("data-attached-pane"),
    ).toBe("%77");
    expect(
      [...h.native.values()].filter((candidate) =>
        candidate.sessionName.startsWith("loom-lead-"),
      ),
    ).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("Ctrl+1 opens Main when there are no agents", async () => {
  const h = await harness();
  try {
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        h.element
          .querySelector("[data-attached-pane]")
          ?.getAttribute("data-attached-pane"),
      ).toBe("%77"),
    );
  } finally {
    await h.close();
  }
});

test("numbered agent shortcuts reserve Ctrl+1 for Main and shift agents down", async () => {
  const agents = [
    {
      ...pane,
      id: JSON.stringify([pane.hostGeneration, "%10"]),
      paneId: "%10",
      sessionName: "agent-a",
      sessionId: "$10",
      windowId: "@10",
      provider: "codex",
    },
    {
      ...pane,
      id: JSON.stringify([pane.hostGeneration, "%11"]),
      paneId: "%11",
      sessionName: "agent-b",
      sessionId: "$11",
      windowId: "@11",
      provider: "claude",
    },
  ];
  const h = await harness(agents);
  const pressAgent = async (number: string) =>
    act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: number,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  const attachedPane = () =>
    h.element
      .querySelector("[data-attached-pane]")
      ?.getAttribute("data-attached-pane");
  try {
    await pressAgent("1");
    await vi.waitFor(() => expect(attachedPane()).toBe("%77"));
    expect(h.send).toHaveBeenLastCalledWith({
      kind: "open_lead_session",
      repoId: snapshot().repos[0]?.id,
    });

    await pressAgent("2");
    expect(attachedPane()).toBe("%10");
    await pressAgent("3");
    expect(attachedPane()).toBe("%11");
    await pressAgent("4");
    expect(attachedPane()).toBe("%11");
  } finally {
    await h.close();
  }
});

test("Ctrl+1 does nothing when no repository is selected", async () => {
  const h = await harness([], false, false);
  try {
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test("pinned Main waits for its exact pane when acknowledgement arrives first", async () => {
  const decoy = {
    ...pane,
    id: JSON.stringify([pane.hostGeneration, "%76"]),
    paneId: "%76",
    sessionName: "loom-main",
  };
  const h = await harness([decoy], true);
  try {
    await act(async () =>
      h.element
        .querySelector<HTMLButtonElement>('[data-pinned="main"]')
        ?.click(),
    );
    await vi.waitFor(() =>
      expect(
        h.element
          .querySelector("[data-attached-pane]")
          ?.getAttribute("data-attached-pane"),
      ).toBe("%77"),
    );
  } finally {
    await h.close();
  }
});
