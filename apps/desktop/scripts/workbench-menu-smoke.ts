// Built Electron UI and owned shell panes on a disposable coordinator.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskId, WorktreePath } from "@loom/core";
import { _electron as electron } from "playwright";
import { startDesktopHarness } from "./desktop-harness.js";

declare const window: {
  loom: {
    store: { getState(): { connection: string } };
    terms?: Record<string, unknown>;
  };
};
declare const document: { activeElement: unknown };
const temporary = await mkdtemp(join(tmpdir(), "loom-menu-smoke-"));
const harness = await startDesktopHarness({ terminals: true });
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const host = harness.host;
  assert.ok(host);
  const workspace = await host.ensureWorkspace({
    taskId: "menu" as TaskId,
    cwd: harness.h.repo.root,
    label: "menu",
  });
  const request = {
    workspaceId: workspace.workspaceId,
    createWorkspace: true,
    key: randomUUID(),
    label: "shell",
    cwd: harness.h.repo.root as WorktreePath,
    executable: "/bin/sh",
    args: ["-l"],
    env: { PATH: "/usr/bin:/bin", HOME: temporary, LANG: "en_US.UTF-8" },
  };
  const firstPane = await host.createScratch(request);
  const secondPane = await host.createScratch({
    ...request,
    key: randomUUID(),
    target: firstPane,
    split: "right",
  });
  await host.setTitle({
    hostGeneration: secondPane.hostGeneration,
    target: { kind: "pane", paneId: secondPane.paneId },
    title: "unique",
  });
  app = await electron.launch({
    args: [
      fileURLToPath(new URL("..", import.meta.url)),
      `--user-data-dir=${join(temporary, "electron")}`,
    ],
    env: {
      ...harness.env,
      ELECTRON_RENDERER_URL: "",
      LOOM_WINDOW_MODE: "workbench",
      LOOM_EXIT_WHEN_INTERACTIVE: "",
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".wb-sidebar");
  await page.waitForFunction(
    () => window.loom?.store.getState().connection === "connected",
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
  await page
    .getByRole("button", { name: `Open shell unique ${secondPane.paneId}` })
    .focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Row actions" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: `Open shell unique ${secondPane.paneId}` })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  console.log(
    "Workbench menu smoke passed: real split geometry, viewer detach, retained rows, keyboard menu.",
  );
} finally {
  try {
    await app?.close();
  } finally {
    try {
      await harness.close();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
