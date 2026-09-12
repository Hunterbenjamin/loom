// Regression against a real attach client. Owns only a throwaway tmux server and Electron app;
// never connects to a user's pane or starts a coding agent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "loom-terminal-"));
const instance = `test-${process.pid}`;
const env = {
  ...process.env,
  TMUX: "",
  TMUX_TMPDIR: temporary,
  LOOM_INSTANCE: instance,
  LOOM_ATTACH_PANE: "resize:@0",
  LOOM_WIDTH: "1440",
  LOOM_HEIGHT: "900",
  LOOM_EXIT_WHEN_INTERACTIVE: "",
  ELECTRON_RENDERER_URL: "",
};
const tmux = (...args) =>
  execFileSync(
    process.env.LOOM_TMUX_BIN ?? "tmux",
    ["-L", `loom-${instance}`, "-f", "/dev/null", ...args],
    {
      env,
      encoding: "utf8",
    },
  ).trim();

let app;
try {
  tmux(
    "new-session",
    "-d",
    "-s",
    "resize",
    "-x",
    "100",
    "-y",
    "30",
    "/bin/sh",
    "-c",
    "while :; do printf '\\033[H%0200d\\r\\n' 0; sleep 0.05; done",
  );
  tmux("set-option", "-w", "-t", "resize:@0", "window-size", "latest");
  tmux("set-option", "-w", "-t", "resize:@0", "aggressive-resize", "on");
  // Grouped attach sessions inherit global session options, not the source's local options.
  tmux("set-option", "-g", "status", "off");

  app = await electron.launch({
    args: [root, `--user-data-dir=${join(temporary, "electron")}`],
    cwd: root,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.loom?.ready === true);
  await app.evaluate(({ ipcMain }) => {
    globalThis.terminalResizes = [];
    ipcMain.on("pty:resize", (_event, _id, cols, rows) => {
      globalThis.terminalResizes.push({ cols, rows });
    });
  });
  await page.evaluate(() => {
    const { snapshot } = window.loom.store.getState();
    window.loom.store.open(snapshot.tasks[0].id);
    window.loom.store.setTab("terminal");
  });
  await page.waitForFunction(
    () =>
      window.loom.term &&
      document.querySelector(".terminal-bar").textContent.includes("pid "),
  );
  await page.waitForFunction(() =>
    window.loom.term.buffer.active
      .getLine(0)
      ?.translateToString()
      .includes("00000"),
  );

  for (const [width, height] of [
    [1440, 900],
    [1000, 650],
    [1600, 1000],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        globalThis.terminalResizes = [];
        BrowserWindow.getAllWindows()[0].setSize(...size);
      },
      [width, height],
    );
    const samples = await page.evaluate(async () => {
      const samples = [];
      const start = performance.now();
      // Covers the 80ms debounce plus many frames and several tmux redraws after settling.
      while (performance.now() - start < 700) {
        await new Promise(requestAnimationFrame);
        const term = window.loom.term;
        const boxes = [
          ".tab-body",
          ".terminal-wrap",
          ".terminal-host",
          ".terminal-viewport",
        ].map((selector) => {
          const element = document.querySelector(selector);
          return {
            selector,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
          };
        });
        samples.push({
          ms: performance.now() - start,
          cols: term.cols,
          rows: term.rows,
          boxes,
        });
      }
      return samples;
    });
    const settled = samples.filter((sample) => sample.ms >= 200);
    const sizes = new Set(settled.map(({ cols, rows }) => `${cols}x${rows}`));
    const resizes = await app.evaluate(() => globalThis.terminalResizes);
    const final = samples.at(-1);
    console.log(
      JSON.stringify({
        width,
        height,
        first: samples[0],
        final,
        settledSizes: [...sizes],
        resizes,
      }),
    );
    for (const sample of samples) {
      for (const box of sample.boxes) {
        assert.ok(
          box.width > 0 && box.scrollWidth <= box.width,
          `${box.selector} overflow: ${box.scrollWidth} > ${box.width}`,
        );
      }
    }
    assert.ok(settled.length >= 10, "sample enough frames after the debounce");
    assert.equal(sizes.size, 1, "columns and rows must settle within 200ms");
    assert.ok(resizes.length <= 2, "no continuing PTY resize feedback");
    for (let i = 1; i < resizes.length; i++) {
      assert.notDeepEqual(
        resizes[i],
        resizes[i - 1],
        "do not send duplicate PTY dimensions",
      );
    }
    assert.equal(
      tmux(
        "display-message",
        "-p",
        "-t",
        "resize:@0",
        "#{pane_width}x#{pane_height}",
      ),
      `${final.cols}x${final.rows}`,
      "tmux must receive the fitted dimensions",
    );
  }
  console.log("Terminal resize regression passed (real PTY + isolated tmux).");
} finally {
  try {
    await app?.close();
  } finally {
    try {
      tmux("kill-server");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
