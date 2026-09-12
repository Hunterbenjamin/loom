// Captures the four screens in both themes into docs/screenshots, for the PR and for
// eyeballing a change. Same launch method as the performance harness.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "screenshots");
mkdirSync(out, { recursive: true });

const frame = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

const app = await electron.launch({
  args: [root, "--fixtures"],
  cwd: root,
  env: { ...process.env, LOOM_WIDTH: "1360", LOOM_HEIGHT: "860" },
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
        (candidate) => candidate.stage === "in_review",
      );
      window.loom.store.open(task.id);
      window.loom.store.setTab("activity");
    });
  },
  review: async () => {
    await page.evaluate(async () => {
      const counts = new Map();
      for (const finding of window.loom.store.getState().snapshot.findings) {
        counts.set(finding.taskId, (counts.get(finding.taskId) ?? 0) + 1);
      }
      let worst = null;
      for (const [taskId, count] of counts)
        if (!worst || count > worst[1]) worst = [taskId, count];
      window.loom.store.open(worst[0]);
      window.loom.store.setTab("review");
    });
  },
};

for (const theme of ["dark", "light"]) {
  await page.evaluate((value) => window.loom.store.setTheme(value), theme);
  for (const [name, setup] of Object.entries(screens)) {
    await setup();
    await page.evaluate(frame);
    // Give the diff renderer and its workers a moment to highlight.
    await new Promise((resolve) =>
      setTimeout(resolve, name === "review" ? 2500 : 400),
    );
    const file = join(out, `${name}-${theme}.png`);
    // `scale: "css"` captures at CSS pixel size, so a Retina run does not commit 4x the bytes.
    await page.screenshot({ path: file, scale: "css" });
    console.log(file);
  }
}

await app.close();
