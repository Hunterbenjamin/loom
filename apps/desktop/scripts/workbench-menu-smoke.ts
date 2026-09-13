// Built Electron UI, fixture-only shells, and an isolated user-data directory.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptySnapshotBody, stateFromSnapshot } from "@loom/protocol";
import { _electron as electron } from "playwright";
import { pane } from "../../../packages/protocol/src/pane-fixture.js";
import { meta } from "../../../packages/protocol/src/test-support.js";
import type { Store } from "../src/renderer/store/store.js";

declare const window: {
  loom: { store: Store; terms?: Record<string, unknown> };
};
const temporary = await mkdtemp(join(tmpdir(), "loom-menu-smoke-"));
const app = await electron.launch({
  args: [
    fileURLToPath(new URL("..", import.meta.url)),
    "--fixtures",
    `--user-data-dir=${join(temporary, "electron")}`,
  ],
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: "",
    LOOM_WINDOW_MODE: "workbench",
    LOOM_ATTACH_PANE: "",
    LOOM_EXIT_WHEN_INTERACTIVE: "",
    LOOM_DATA_ROOT: temporary,
    LOOM_INSTANCE: "dev",
  },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".wb-sidebar");
  const state = stateFromSnapshot(meta, {
    ...emptySnapshotBody(),
    panes: [
      pane,
      {
        ...pane,
        id: JSON.stringify([pane.hostGeneration, "%8"]),
        paneId: "%8",
        command: "unique",
      },
    ],
  });
  await page.evaluate(
    (encoded) =>
      window.loom.store.applyProtocol(
        JSON.parse(encoded, (_key, value) =>
          value?.__map ? new Map(value.__map) : value,
        ),
      ),
    JSON.stringify(state, (_key, value) =>
      value instanceof Map ? { __map: [...value] } : value,
    ),
  );
  await page
    .getByRole("textbox", { name: "Find space, tab or pane" })
    .fill("unique");
  await page
    .getByRole("button", { name: "Open tab shell", exact: true })
    .click();
  const panels = page.locator(".wb-tab:visible [data-panel]");
  await panels.first().waitFor({ state: "visible" });
  await panels.nth(1).waitFor({ state: "visible" });
  const first = await panels.first().boundingBox();
  const second = await panels.nth(1).boundingBox();
  assert.ok(first && second && first.width > 100 && second.width > 100);
  assert.ok(
    second.x >= first.x + first.width - 2,
    "tab panes should be side by side",
  );
  const clientsBefore = await page.evaluate(() =>
    Object.keys(window.loom.terms ?? {}),
  );
  await page
    .getByRole("button", { name: "Open tab shell", exact: true })
    .click({ button: "right" });
  await page.getByRole("menu", { name: "Row actions" }).waitFor();
  await page.screenshot({ path: join(tmpdir(), "loom-workbench-menu.png") });
  await page
    .getByRole("menuitem", { name: "Close panel", exact: true })
    .click();
  await panels.first().waitFor({ state: "hidden" });
  await page.waitForFunction(
    (old) => old.every((id) => !(id in (window.loom.terms ?? {}))),
    clientsBefore,
  );
  assert.equal(
    await page.locator(".wb-tree-pane[data-pane-key]").count(),
    1,
    "closing viewers preserves filtered native inventory",
  );
  await page.getByRole("button", { name: "Open shell unique %8" }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Row actions" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "Open shell unique %8" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  console.log(
    "Workbench menu smoke passed: real split geometry, viewer detach, retained rows, keyboard menu.",
  );
} finally {
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
