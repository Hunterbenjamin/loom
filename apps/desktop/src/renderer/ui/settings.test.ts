// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, MODEL_CATALOG, SETTINGS_CATALOG } from "@loom/core";
import { type AckOutcome, stateFromSnapshot } from "@loom/protocol";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { toSnapshot } from "../fixtures/protocol.js";
import { StoreProvider } from "../store/react.js";
import { createStore } from "../store/store.js";
import { SettingsView } from "./settings.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

test("settings supports scope-aware editing, save feedback, and redacted audit history", async () => {
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
      scope: { kind: "repository" as const, repoId: repo.id },
      audit: [],
    },
  ] as never;
  const store = createStore(snapshot, true, "dev");
  store.applyProtocol(stateFromSnapshot(wire.meta, wire.body));
  const send = vi
    .fn<(command: unknown) => Promise<AckOutcome>>()
    .mockResolvedValue({
      ok: true,
      result: {
        kind: "settings_updated",
        scope: { kind: "global" },
        version: 1,
      },
    });
  store.setSender(send);
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () =>
      root.render(
        createElement(StoreProvider, {
          store,
          // biome-ignore lint/correctness/noChildrenProp: StoreProvider requires children in its typed props.
          children: createElement(SettingsView),
        }),
      ),
    );
    const scope = host.querySelector<HTMLSelectElement>(
      ".settings-intro select",
    );
    if (!scope) throw new Error("Missing scope selector");
    await act(async () => {
      scope.value = "global";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("Recent changes");
    expect(host.textContent).toContain("appearance.theme changed by desktop");
    const theme = host.querySelector<HTMLSelectElement>(
      "#setting-appearance-theme",
    );
    if (!theme) throw new Error("Missing theme setting");
    await act(async () => {
      theme.value = "light";
      theme.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const appearance = [...host.querySelectorAll("section")].find((section) =>
      section.textContent?.includes("Appearance"),
    );
    const save = [...(appearance?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save?.click());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update_settings",
        patch: { appearance: { theme: "light" } },
      }),
    );
    expect(host.textContent).toContain("Appearance saved");
    send.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "conflict",
        message: "Settings changed in another window",
        details: [],
      },
    });
    const reset = [...(appearance?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Reset defaults",
    );
    await act(async () => reset?.click());
    expect(send).toHaveBeenLastCalledWith({
      kind: "reset_settings",
      scope: { kind: "global" },
      expectedVersion: 1,
      keys: ["appearance.theme"],
    });
    expect(host.textContent).toContain("Settings changed in another window");
    await act(async () => {
      scope.value = `repo:${repo.id}`;
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      host.querySelector<HTMLInputElement>("#setting-runtime-capTotal")
        ?.disabled,
    ).toBe(true);
    expect(host.textContent).toContain("Instance-wide; edit Global defaults");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
