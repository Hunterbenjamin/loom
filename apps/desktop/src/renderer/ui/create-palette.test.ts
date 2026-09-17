// @vitest-environment happy-dom
import type { ResearchSummary } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { CREATABLES, CreateDialog } from "./creatables.js";
import { useShortcuts } from "./keys.js";
import { CreatePalette, Palette } from "./palette.js";
import { registerTrackerActions } from "./tracker-actions.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() =>
  act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  }),
);

function setup() {
  const store = createFixtureStore(buildSnapshot());
  const host = document.createElement("div");
  const trigger = document.createElement("button");
  document.body.append(trigger, host);
  trigger.focus();
  const root = createRoot(host);
  function Surface() {
    useShortcuts(store);
    return createElement(
      "div",
      null,
      createElement(CreatePalette),
      createElement(Palette),
      createElement(CreateDialog),
    );
  }
  act(() =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: typed provider requires children.
        children: createElement(Surface),
      }),
    ),
  );
  cleanups.push(() => {
    root.unmount();
    host.remove();
    trigger.remove();
  });
  const key = (key: string, target: EventTarget = document.activeElement!) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  return { store, host, trigger, key };
}

test("c opens all registered descriptions; Escape restores focus and preserves detail", () => {
  const h = setup();
  act(() => h.store.openResearch("existing"));
  h.key("c");
  expect(h.store.getState().ui.createPalette).toBe(true);
  expect(h.host.querySelectorAll("[cmdk-item]")).toHaveLength(
    CREATABLES.length,
  );
  for (const entry of CREATABLES) {
    expect(h.host.textContent).toContain(entry.label);
    expect(h.host.textContent).toContain(entry.description);
  }
  h.key("Escape");
  expect(h.store.getState().ui.createPalette).toBe(false);
  expect(h.store.getState().ui.openResearch).toBe("existing");
  expect(document.activeElement).toBe(h.trigger);
});

for (const entry of CREATABLES)
  test(`selecting ${entry.label} opens its dialog and restores focus on cancellation`, () => {
    const h = setup();
    h.key("c");
    const item = [...h.host.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
      (item) => item.textContent?.startsWith(entry.label),
    );
    act(() => item!.click());
    expect(h.store.getState().ui).toMatchObject({
      create: entry.id,
      createPalette: false,
    });
    expect(h.host.querySelector("h2")?.textContent).toBe(
      `Create ${entry.label.toLowerCase()}`,
    );
    act(() =>
      h.host
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(document.activeElement).toBe(h.trigger);
  });

test("command palette registers a direct creation command for every entry", () => {
  const h = setup();
  for (const entry of CREATABLES) {
    act(() => h.store.setPalette(true));
    const item = [
      ...h.host.querySelectorAll<HTMLElement>(
        '[cmdk-group][data-value="Create"] [cmdk-item]',
      ),
    ].find(
      (item) => item.textContent === `Create ${entry.label.toLowerCase()}…`,
    );
    expect(item).toBeDefined();
    act(() => item!.click());
    expect(h.store.getState().ui).toMatchObject({
      create: entry.id,
      palette: false,
    });
    act(() => h.store.setCreate(null));
  }
});

test("section commands appear once for Sections and use the active adapter", () => {
  const h = setup();
  const commands = () => [
    ...h.host.querySelectorAll<HTMLElement>(
      '[cmdk-group][data-value="Sections"] [cmdk-item]',
    ),
  ];
  for (const view of ["all", "pull-requests"] as const) {
    act(() => {
      h.store.setView(view);
      h.store.setPalette(true);
    });
    expect(
      commands().map((item) => item.querySelector("kbd")?.textContent),
    ).toEqual(["l", "h", "}", "{"]);
    act(() => commands()[2]!.click());
    expect(
      view === "all"
        ? h.store.getState().ui.cursor
        : h.store.getState().ui.prCursor,
    ).toBe(0);
    expect(h.store.getState().ui.palette).toBe(false);
  }
  for (const view of ["needs-you", "briefs", "research", "settings"] as const) {
    act(() => {
      h.store.setView(view);
      h.store.setPalette(true);
    });
    expect(commands()).toHaveLength(0);
  }
  act(() => {
    h.store.setView("all");
    h.store.setPane("board");
  });
  expect(commands()).toHaveLength(0);
});

test("local sections and archive actions appear only while their page registers them", () => {
  const h = setup();
  act(() => h.store.setView("research"));
  let archived = false;
  const remove = registerTrackerActions(h.store, {
    archive: () => {
      archived = true;
    },
    "collapse-section": () => {},
  });
  act(() => h.store.setPalette(true));
  expect(h.host.textContent).toContain("Collapse or expand section");
  const item = [...h.host.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (item) => item.textContent?.includes("Archive / unarchive research"),
  );
  act(() => item!.click());
  expect(archived).toBe(true);
  remove();
  act(() => h.store.setPalette(true));
  expect(h.host.textContent).not.toContain("Archive / unarchive research");
  expect(h.host.textContent).not.toContain("Collapse or expand section");
});

test("palette fetches on open, searches research questions and opens by stored name", async () => {
  const h = setup();
  const entry: ResearchSummary = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Keyboard modes",
    question: "How does remapping work?",
    title: "Full document title",
    origin: "main",
    status: "completed",
    directory: null,
    pane: null,
    observedStatus: "unknown",
    sessionId: null,
    provider: null,
    model: null,
    startedAt: "2026-09-16T00:00:00.000Z",
    finishedAt: null,
    archivedAt: null,
    error: null,
  };
  let reads = 0;
  h.store.setSender(async (command) => {
    expect(command).toEqual({ kind: "list_research", archived: "all" });
    reads++;
    return {
      ok: true,
      result: {
        kind: "research_list",
        state: { entries: [entry], runningId: null },
      },
    };
  });
  expect(reads).toBe(0);
  await act(async () => h.store.setPalette(true));
  expect(reads).toBe(1);
  const input = h.host.querySelector<HTMLInputElement>("[cmdk-input]")!;
  for (const query of ["Keyboard", "remapping"]) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const item = h.host.querySelector<HTMLElement>(
      '[cmdk-group][data-value="Research"] [cmdk-item]',
    );
    expect(item?.textContent).toBe(entry.name);
    expect(reads).toBe(1);
  }
  await act(async () =>
    h.host
      .querySelector<HTMLElement>(
        '[cmdk-group][data-value="Research"] [cmdk-item]',
      )!
      .click(),
  );
  expect(h.store.getState().ui).toMatchObject({
    palette: false,
    view: "research",
    openResearch: entry.id,
  });
  await act(async () => h.store.setPalette(true));
  expect(reads).toBe(2);
});
