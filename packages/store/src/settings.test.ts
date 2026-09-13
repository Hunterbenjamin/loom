import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { config, now } from "../test/fixtures.js";
import { openStore, type Store } from "./index.js";

let root: string;
let store: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "loom-settings-"));
  store = await openStore({ dataRoot: root, instance: "dev", config, now });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("round-trips scoped values with optimistic versions and ordered audit", () => {
  const scope = { kind: "global" } as const;
  expect(store.settings.read(scope)).toMatchObject({ version: 0, data: {} });
  const first = store.settings.update({
    scope,
    expectedVersion: 0,
    data: { workflow: { size: "small" } },
    actor: "test",
    changedAt: now,
    changes: [{ key: "workflow.size", oldValue: undefined, newValue: "small" }],
  });
  expect(first.version).toBe(1);
  expect(store.settings.read(scope).data).toEqual({
    workflow: { size: "small" },
  });
  expect(store.settings.audit()).toEqual([
    expect.objectContaining({
      settingKey: "workflow.size",
      newValue: "small",
      settingsVersion: 1,
    }),
  ]);
  expect(() =>
    store.settings.update({
      scope,
      expectedVersion: 0,
      data: {},
      actor: "stale",
      changedAt: now,
      changes: [],
    }),
  ).toThrow("Settings changed in another window");
  expect(store.settings.read(scope).version).toBe(1);
});

it("rejects secret-bearing documents and audit records before writing", () => {
  const scope = { kind: "global" } as const;
  expect(() =>
    store.settings.update({
      scope,
      expectedVersion: 0,
      data: { futureToken: "do-not-store" } as never,
      actor: "test",
      changedAt: now,
      changes: [],
    }),
  ).toThrow("Secret-bearing setting");
  expect(() =>
    store.settings.update({
      scope,
      expectedVersion: 0,
      data: {},
      actor: "test",
      changedAt: now,
      changes: [
        {
          key: "provider.apiKey",
          oldValue: undefined,
          newValue: "do-not-audit",
        },
      ],
    }),
  ).toThrow("Secret-bearing audit key");
  expect(store.settings.audit()).toEqual([]);
});
