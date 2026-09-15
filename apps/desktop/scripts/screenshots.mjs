// Captures the three screens in both themes into docs/screenshots, for the PR and for
// eyeballing a change. Same launch method as the performance harness.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { startDesktopHarness } from "./desktop-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "screenshots");
mkdirSync(out, { recursive: true });

const frame = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

const harness = await startDesktopHarness();
const userData = mkdtempSync(join(tmpdir(), "loom-screenshots-"));
let app;
try {
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...harness.env, LOOM_WIDTH: "1360", LOOM_HEIGHT: "860" },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.loom?.ready === true, null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".row");

  const screens = {
    list: async () => {
      await page.evaluate(async () => {
        window.loom.store.open(null);
        window.loom.store.setPane("list");
        window.loom.store.setView("all");
        window.loom.store.setCursor(4);
      });
    },
    board: async () => {
      await page.evaluate(async () => {
        window.loom.store.open(null);
        window.loom.store.setPane("board");
      });
    },
    detail: async () => {
      await page.evaluate(async () => {
        const { snapshot } = window.loom.store.getState();
        const task = snapshot.tasks.find(
          (candidate) => candidate.stage === "plan_approval",
        );
        window.loom.store.open(task.id);
        window.loom.store.setTab("plan");
      });
    },
  };

  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => window.loom.store.setTheme(value), theme);
    for (const [name, setup] of Object.entries(screens)) {
      await setup();
      await page.evaluate(frame);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const file = join(out, `${name}-${theme}.png`);
      // `scale: "css"` captures at CSS pixel size, so a Retina run does not commit 4x the bytes.
      await page.screenshot({ path: file, scale: "css" });
      console.log(file);
    }
  }
} finally {
  try {
    await app?.close();
  } finally {
    try {
      await harness.close();
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }
}
