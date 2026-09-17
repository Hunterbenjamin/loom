// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  KEYBINDING_ACTIONS,
  MODEL_CATALOG,
  SETTINGS_CATALOG,
} from "@loom/core";
import {
  type AckOutcome,
  type BriefState,
  stateFromSnapshot,
} from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { defaultKeybindings } from "../../shared/keybindings.js";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { SettingsView } from "./settings.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function mount() {
  const snapshot = buildSnapshot();
  const repo = snapshot.repos[0];
  if (!repo) throw new Error("Missing repository fixture");
  const wire = toSnapshot(snapshot);
  const catalog = structuredClone(SETTINGS_CATALOG);
  const defaults = structuredClone(DEFAULT_SETTINGS);
  const base = {
    version: 1,
    stored: { appearance: { theme: "dark" as const } },
    defaults,
    effective: defaults,
    sources: Object.fromEntries(catalog.map((item) => [item.key, "default"])),
    catalog,
    modelCatalog: structuredClone(MODEL_CATALOG),
    credentialReadiness: { codex: true, claude: false, github: true },
    audit: [
      {
        id: 1,
        scope: { kind: "global" as const },
        actor: "desktop",
        changedAt: "2026-09-13T00:00:00.000Z",
        settingKey: "appearance.theme",
        settingsVersion: 1,
      },
    ],
  };
  wire.body.settings = [
    { ...base, id: "global", scope: { kind: "global" as const } },
    {
      ...base,
      id: `repo:${repo.id}`,
      stored: {},
      scope: { kind: "repository" as const, repoId: repo.id },
      audit: [],
    },
  ] as never;
  const store = createStore(snapshot, "dev");
  store.applyProtocol(stateFromSnapshot(wire.meta, wire.body));
  const send = vi
    .fn<(command: unknown) => Promise<AckOutcome>>()
    .mockResolvedValue({
      ok: true,
      result: {
        kind: "settings_updated",
        scope: { kind: "global" },
        version: 2,
      },
    });
  store.setSender(send);
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      createElement(StoreProvider, {
        store,
        // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
        children: createElement(SettingsView),
      }),
    ),
  );
  const button = (text: string, within: ParentNode = host) => {
    const found = [...within.querySelectorAll("button")].find(
      (item) =>
        item.textContent === text || item.getAttribute("aria-label") === text,
    );
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };
  const section = async (name: string) =>
    act(async () => button(name, host.querySelector("nav") ?? host).click());
  const group = (title: string) => {
    const found = host.querySelector(`section[aria-label="${title}"]`);
    if (!found) throw new Error(`Missing group ${title}`);
    return found;
  };
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
  return { host, send, store, repo, button, section, group, settle };
}

const press = (init: KeyboardEventInit) =>
  act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ...init }),
    );
  });

test("changes save as soon as they are made, reset per setting, and show errors in place", async () => {
  const { host, send, button, group, settle } = await mount();
  await act(async () => button("Light", group("Appearance")).click());
  await settle();
  expect(send).toHaveBeenCalledWith({
    kind: "update_settings",
    scope: { kind: "global" },
    expectedVersion: 1,
    patch: { appearance: { theme: "light" } },
  });

  send.mockResolvedValueOnce({
    ok: false,
    error: {
      code: "conflict",
      message: "Settings changed in another window",
      details: [],
    },
  });
  await act(async () => button("Reset", group("Appearance")).click());
  await settle();
  expect(send).toHaveBeenLastCalledWith({
    kind: "reset_settings",
    scope: { kind: "global" },
    // The earlier save acknowledged version 2.
    expectedVersion: 2,
    keys: ["appearance.theme"],
  });
  expect(host.textContent).toContain("Settings changed in another window");
});

test("repository scope writes overrides, and global-only settings stay read-only there", async () => {
  const { host, send, repo, button, section, group, settle } = await mount();
  await section("Workflow");
  await act(async () => button(repo.github).click());
  const approval = host.querySelector<HTMLInputElement>(
    "#setting-workflow-requirePlanApproval",
  );
  if (!approval) throw new Error("Missing plan approval switch");
  await act(async () => approval.click());
  await settle();
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "update_settings",
      scope: { kind: "repository", repoId: repo.id },
      patch: { workflow: { requirePlanApproval: true } },
    }),
  );
  await section("Agents");
  expect(
    host.querySelector<HTMLSelectElement>("#setting-main-model")?.disabled,
  ).toBe(true);
  expect(group("Main").textContent).toContain("Set for all repositories");
});

test("a shortcut is recorded from a key press, including prefix sequences, and conflicts are named", async () => {
  const { host, send, button, section, group, settle } = await mount();
  await section("Keyboard");
  const panels = group("Panels");

  await act(async () => button("Add shortcut for Split right", panels).click());
  expect(host.textContent).toContain("Press keys");
  await press({ key: "e", code: "KeyE", metaKey: true });
  await settle();
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: "update_settings",
      patch: {
        appearance: {
          keybindings: expect.objectContaining({
            "split-right": ["Cmd+D", "Prefix |", "Cmd+E"],
          }),
        },
      },
    }),
  );

  send.mockClear();
  await act(async () => button("Add shortcut for Split right", panels).click());
  await press({ key: "t", code: "KeyT", metaKey: true });
  expect(send).not.toHaveBeenCalled();
  expect(panels.textContent).toContain("Already used by New tab.");

  await act(async () => button("Add shortcut for Zoom panel", panels).click());
  await press({ key: " ", code: "Space", ctrlKey: true });
  expect(host.textContent).toContain("then…");
  await press({ key: "e", code: "KeyE" });
  await settle();
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      patch: {
        appearance: {
          keybindings: expect.objectContaining({
            zoom: [...defaultKeybindings.bindings.zoom, "Prefix E"],
          }),
        },
      },
    }),
  );

  await act(async () => button("Remove Cmd+W", panels).click());
  await settle();
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      patch: {
        appearance: {
          keybindings: expect.objectContaining({ close: ["Prefix x"] }),
        },
      },
    }),
  );
});

test("Research settings switch provider, model and reasoning together and save depth", async () => {
  const { section, host, send, settle } = await mount();
  await section("Agents");
  const provider = host.querySelector(
    "#setting-research-provider",
  ) as HTMLSelectElement;
  expect(provider.value).toBe("codex");
  await act(async () => {
    provider.value = "claude";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "update_settings",
      patch: {
        research: {
          provider: "claude",
          model: MODEL_CATALOG.providers.claude.models[0],
          reasoningEffort: null,
        },
      },
    }),
  );
  const depth = host.querySelector(
    "#setting-research-depth",
  ) as HTMLSelectElement;
  await act(async () => {
    depth.value = "deep";
    depth.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ patch: { research: { depth: "deep" } } }),
  );
});

test("Keyboard settings exposes every action in its source group, including terminal reading", async () => {
  const { section, group, button } = await mount();
  await section("Keyboard");
  for (const action of KEYBINDING_ACTIONS) {
    expect(
      button(`Add shortcut for ${action.label}`, group(action.group)),
    ).toBeDefined();
  }
});

test("Agents owns the instance daily schedule and reconciles changes", async () => {
  const h = await mount();
  act(() => h.store.setConnection("connected"));
  const state: BriefState = {
    schedule: { enabled: true, hour: 7, timeZone: "Asia/Makassar" },
    runs: [],
  };
  h.send.mockImplementation(async (input) => {
    const command = input as { kind: string; enabled?: boolean };
    if (command.kind === "set_brief_schedule")
      state.schedule.enabled = command.enabled!;
    return {
      ok: true,
      result: { kind: "briefs", state: structuredClone(state) },
    };
  });
  await act(async () => h.button("Agents").click());
  const checkbox = h.host.querySelector<HTMLInputElement>("#brief-schedule")!;
  expect(checkbox.checked).toBe(true);
  expect(h.host.textContent).toContain("7:00 a.m. · Asia/Makassar");
  await act(async () => checkbox.click());
  expect(h.send).toHaveBeenCalledWith({
    kind: "set_brief_schedule",
    enabled: false,
  });
  expect(checkbox.checked).toBe(false);
  h.send.mockRejectedValueOnce(new Error("Schedule unavailable"));
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(h.host.textContent).toContain("Schedule unavailable");
});
