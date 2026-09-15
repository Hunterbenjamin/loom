// Native menu and xterm checks against a disposable coordinator and owned shell panes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { startDesktopHarness } from "./desktop-harness.mjs";

const temporary = await mkdtemp(join(tmpdir(), "loom-keybindings-smoke-"));
const harness = await startDesktopHarness({ terminals: true });
let app;
try {
  app = await electron.launch({
    args: [
      fileURLToPath(new URL("..", import.meta.url)),
      `--user-data-dir=${join(temporary, "electron")}`,
    ],
    env: {
      ...harness.env,
      HOME: temporary,
      SHELL: "/bin/sh",
      LOOM_WINDOW_MODE: "workbench",
      ELECTRON_RENDERER_URL: "",
      LOOM_EXIT_WHEN_INTERACTIVE: "",
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".wb-sidebar");
  await page.waitForFunction(
    () => window.loom?.store.getState().connection === "connected",
  );
  const config = await page.evaluate(() =>
    window.loomHost.keybindings().then((state) => state.config),
  );
  assert.equal(config.prefixTimeoutMs, 3000);
  const native = await app.browserWindow(page);
  const press = async (keyCode, modifiers = []) => {
    await native.evaluate(
      (window, { keyCode, modifiers }) => {
        window.webContents.sendInputEvent({
          type: "keyDown",
          keyCode,
          modifiers,
        });
        window.webContents.sendInputEvent({
          type: "keyUp",
          keyCode,
          modifiers,
        });
      },
      { keyCode, modifiers },
    );
  };
  const focusTerminal = async () => {
    await page
      .locator(".wb-tab:visible .terminal-bar")
      .getByText(/^pid /)
      .last()
      .waitFor();
    await page.locator(".wb-tab:visible textarea").last().focus();
  };
  const create = async () => {
    await page
      .getByRole("button", { name: "Create terminal", exact: true })
      .click();
    await page.locator("dialog").waitFor({ state: "detached" });
    await focusTerminal();
  };
  // Verify against actual native accelerators, including the Close Window role.
  await app.evaluate(({ Menu }) => {
    globalThis.keybindingMenuHits = [];
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "File", submenu: [{ role: "close" }] },
        { role: "editMenu" },
        {
          label: "Conflicts",
          submenu: [
            "Command+D",
            "Command+Shift+D",
            "Command+T",
            "Command+Shift+]",
            "Command+Shift+[",
            "Command+Shift+Enter",
            "Command+P",
            ...["Left", "Down", "Up", "Right"].map((d) => `Command+Alt+${d}`),
          ].map((accelerator) => ({
            label: accelerator,
            accelerator,
            click: () => globalThis.keybindingMenuHits.push(accelerator),
          })),
        },
      ]),
    );
  });
  await press("T", ["meta"]);
  await create();
  await press("D", ["meta"]);
  await create();
  assert.equal(await page.locator("[data-panel]").count(), 2);
  await press("D", ["meta", "shift"]);
  await create();
  assert.equal(await page.locator("[data-panel]").count(), 3);
  for (const arrow of ["Left", "Down", "Up", "Right"])
    await press(arrow, ["meta", "alt"]);
  await press("Enter", ["meta", "shift"]);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-panel]")].some(
      (p) => p.style.zIndex === "3",
    ),
  );
  await press("Enter", ["meta", "shift"]);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-panel]")].every(
      (p) => p.style.zIndex !== "3",
    ),
  );
  await press("T", ["meta"]);
  await create();
  const activeTab = () =>
    page.locator('.wb-tabs [aria-pressed="true"]').textContent();
  const second = await activeTab();
  await press("[", ["meta", "shift"]);
  await page.waitForFunction(
    (name) =>
      document.querySelector('.wb-tabs [aria-pressed="true"]')?.textContent !==
      name,
    second,
  );
  await press("]", ["meta", "shift"]);
  await page.waitForFunction(
    (name) =>
      document.querySelector('.wb-tabs [aria-pressed="true"]')?.textContent ===
      name,
    second,
  );
  await page.waitForFunction(() => {
    const tab = [...document.querySelectorAll(".wb-tab")].find(
      (tab) => tab.style.display !== "none",
    );
    return (
      document.activeElement?.tagName === "TEXTAREA" &&
      tab?.contains(document.activeElement)
    );
  });
  await press("P", ["meta"]);
  await page.waitForFunction(
    () => document.activeElement?.id === "agent-filter",
  );
  // Modifier keydown between prefix and symbol was the reported failure.
  for (const selector of [
    ".wb-tab:visible textarea",
    "#agent-filter",
    ".wb-tabs button",
    ".wb-tab:visible header button",
  ]) {
    await page.locator(selector).first().focus();
    await press("A", ["control"]);
    await page
      .getByRole("status")
      .filter({ hasText: "Ctrl+A armed" })
      .waitFor();
    await press("Shift", ["shift"]);
    await press("?", ["shift"]);
    await page.locator(".wb-help").waitFor();
    await page.locator(".wb-help button").click();
  }
  await focusTerminal();
  await press("A", ["control"]);
  await page.getByRole("status").filter({ hasText: "Ctrl+A armed" }).waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "Ctrl+A armed" })
    .waitFor({ state: "detached", timeout: 5000 });
  // Native Cmd+W must leave the window alive and close exactly its focused panel.
  await press("W", ["meta"]);
  await page.waitForFunction(
    () => document.querySelectorAll("[data-panel]").length === 3,
  );
  assert.equal(page.isClosed(), false);
  assert.deepEqual(await app.evaluate(() => globalThis.keybindingMenuHits), []);

  // Coordinator-owned settings reach both windows and update matching/help.
  const nextWindow = app.waitForEvent("window");
  await page.evaluate(() => window.loomHost.openWindow("workbench"));
  const other = await nextWindow;
  await other.waitForSelector(".wb-sidebar");
  config.bindings.help = ["Ctrl+Shift+H"];
  await page.evaluate(async (bindings) => {
    const store = window.loom.store;
    const document = store
      .getState()
      .settings.find((item) => item.id === "global");
    const outcome = await store.command({
      kind: "update_settings",
      scope: { kind: "global" },
      expectedVersion: document.version,
      patch: { appearance: { keybindings: bindings } },
    });
    if (!outcome.ok) throw new Error(outcome.error.message);
  }, config.bindings);
  for (const target of [page, other]) {
    await target.waitForFunction(() =>
      window.loomHost
        .keybindings()
        .then((s) => s.config.bindings.help[0] === "Ctrl+Shift+H"),
    );
    await target.bringToFront();
    await target.locator("#agent-filter").focus();
    const targetNative = await app.browserWindow(target);
    await targetNative.evaluate((window) => {
      window.focus();
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "H",
        modifiers: ["control", "shift"],
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "H",
        modifiers: ["control", "shift"],
      });
    });
    await target.locator(".wb-help").waitFor();
    assert.match(
      await target.locator(".wb-help").textContent(),
      /Ctrl\+Shift\+H/,
    );
    await target.locator(".wb-help button").click();
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: native menu conflicts, real xterm focus, all default chords, shifted prefixes on four surfaces, expiry, two-window settings synchronization",
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
