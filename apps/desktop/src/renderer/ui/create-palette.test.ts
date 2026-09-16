// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createFixtureStore } from "../fixtures/store.js";
import { StoreProvider } from "../store/react.js";
import { CREATABLES, CreateDialog } from "./creatables.js";
import { useShortcuts } from "./keys.js";
import { CreatePalette, Palette } from "./palette.js";

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
