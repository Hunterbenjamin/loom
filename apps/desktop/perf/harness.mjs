// Measures the window against the budgets in budgets.json and writes perf/report.json.
// Exits 1 when a budget is missed. Same method as spike 03: launch the real Electron app with
// background throttling disabled, drive the real renderer, and take CPU from `ps`, because
// Electron's own percentCPUUsage under-reports by roughly 8x.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronBinary from "electron";
import { _electron as electron } from "playwright";
import { startDesktopHarness } from "../scripts/desktop-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const budgets = JSON.parse(readFileSync(join(here, "budgets.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "loom-desktop-perf-"));
const LIST_ROWS = 500;
const harness = await startDesktopHarness({
  count: LIST_ROWS,
  terminals: true,
});
const env = harness.env;
const args = [root, `--user-data-dir=${temporary}`];
let app;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Cold start, measured without Playwright: spawn the Electron binary the way a user launches
 * the app, and read the timestamp the main process prints once the first rows are painted.
 * Attaching a debugger costs a few hundred milliseconds that a real launch never pays.
 */
function coldStart() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(electronBinary, args, {
      cwd: root,
      env: {
        ...env,
        LOOM_WIDTH: "1440",
        LOOM_HEIGHT: "900",
        LOOM_EXIT_WHEN_INTERACTIVE: "1",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the app never reported itself interactive"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/loom:interactive (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]) - startedAt);
    });
  });
}

const step = (name) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);

function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

/** CPU seconds used by the Electron process tree, from `ps`. */
function cpuSeconds(pid) {
  const pids = [pid];
  for (let i = 0; i < pids.length; i += 1) {
    try {
      const out = execFileSync("pgrep", ["-P", String(pids[i])], {
        encoding: "utf8",
      });
      for (const line of out.split("\n"))
        if (line.trim()) pids.push(Number(line.trim()));
    } catch {
      // No children.
    }
  }
  let total = 0;
  for (const child of pids) {
    try {
      const time = execFileSync("ps", ["-o", "cputime=", "-p", String(child)], {
        encoding: "utf8",
      }).trim();
      const parts = time.split(/[:]/).map(Number);
      if (parts.length === 2) total += parts[0] * 60 + parts[1];
      if (parts.length === 3)
        total += parts[0] * 3600 + parts[1] * 60 + parts[2];
    } catch {
      // The process exited between pgrep and ps.
    }
  }
  return total;
}

async function main() {
  const measured = {};

  step("cold start");
  // Three launches; the median, so one slow disk read does not decide the number.
  const coldStarts = [];
  for (let i = 0; i < 3; i += 1) coldStarts.push(await coldStart());
  coldStarts.sort((a, b) => a - b);
  measured.coldStartMs = coldStarts[1];
  measured.coldStartRunsMs = coldStarts;

  app = await electron.launch({
    args,
    cwd: root,
    env: {
      ...env,
      LOOM_WIDTH: "1440",
      LOOM_HEIGHT: "900",
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.loom?.ready === true, null, {
    timeout: 20_000,
  });
  await page.waitForSelector(".row", { timeout: 20_000 });
  // One frame after the first rows exist: that is the point the window is usable.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  step("switching view");
  // ---- switching view
  measured.viewSwitchP95Ms = percentile(
    await page.evaluate(async () => {
      const views = [
        "all",
        "needs-you",
        "in-progress",
        "awaiting-approval",
        "done",
      ];
      const frame = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      const durations = [];
      for (let i = 0; i < 40; i += 1) {
        const start = performance.now();
        window.loom.store.setView(views[i % views.length]);
        await frame();
        durations.push(performance.now() - start);
      }
      window.loom.store.setView("all");
      await frame();
      return durations;
    }),
    95,
  );

  step("opening an issue");
  // ---- opening an issue
  measured.openIssueP95Ms = percentile(
    await page.evaluate(async () => {
      const frame = () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      const tasks = window.loom.store.getState().snapshot.tasks;
      const durations = [];
      for (let i = 0; i < 40; i += 1) {
        const start = performance.now();
        window.loom.store.open(tasks[i % tasks.length].id);
        await frame();
        durations.push(performance.now() - start);
        window.loom.store.open(null);
        await frame();
      }
      return durations;
    }),
    95,
  );

  step("scrolling");
  // ---- scrolling a 500-row list
  const scroll = await page.evaluate(async () => {
    const element = document.querySelector(".list");
    const gaps = [];
    let direction = 1;
    let previous = performance.now();
    const start = previous;
    await new Promise((resolve) => {
      const step = (now) => {
        gaps.push(now - previous);
        previous = now;
        element.scrollTop += 140 * direction;
        if (element.scrollTop <= 0) direction = 1;
        if (
          element.scrollTop + element.clientHeight >=
          element.scrollHeight - 1
        )
          direction = -1;
        if (now - start > 5000) return resolve();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const body = gaps.slice(2);
    return {
      rows: window.loom.store.getState().snapshot.tasks.length,
      fps: (body.length / (performance.now() - start)) * 1000,
      maxGap: Math.max(...body),
    };
  });
  measured.listScrollFps = scroll.fps;
  measured.listScrollMaxFrameGapMs = scroll.maxGap;
  measured.listScrollRows = scroll.rows;

  step("terminal latency");
  // ---- keystroke to glyph
  await page.evaluate((id) => {
    window.loom.store.open(id);
    window.loom.store.setTab("terminal");
  }, harness.terminalTaskId);
  await page.waitForSelector(".xterm-helper-textarea", { timeout: 20_000 });
  await page.waitForFunction(() => window.loom.term !== null, null, {
    timeout: 20_000,
  });
  // Let the shell finish drawing its prompt before timing anything.
  await sleep(1500);
  await page.evaluate(() => {
    const textarea = document.querySelector(".xterm-helper-textarea");
    window.__latency = { sent: [], deltas: [] };
    textarea.addEventListener(
      "keydown",
      () => window.__latency.sent.push(performance.now()),
      true,
    );
    window.loom.term.onWriteParsed(() => {
      const start = window.__latency.sent.shift();
      if (start !== undefined)
        window.__latency.deltas.push(performance.now() - start);
    });
    textarea.focus();
  });
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("KeyX");
    await sleep(80);
  }
  const latency = await page.evaluate(() => window.__latency.deltas);
  measured.terminalKeystrokeP95Ms = percentile(latency, 95);
  measured.terminalKeystrokeP50Ms = percentile(latency, 50);
  measured.terminalKeystrokeSamples = latency.length;

  step("idle cpu");
  // ---- idle CPU
  await page.evaluate(() => {
    window.loom.store.open(null);
  });
  await sleep(2000);
  const pid = app.process().pid;
  const before = cpuSeconds(pid);
  const wallStart = Date.now();
  await sleep(8000);
  const after = cpuSeconds(pid);
  measured.idleCpuPercent =
    ((after - before) / ((Date.now() - wallStart) / 1000)) * 100;

  step("closing");
  await app.close();
  app = undefined;

  step("Workbench live inventory, layout, terminals and scratch");
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "scripts/workbench-smoke.ts"], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Workbench harness exited ${code}`)),
    );
  });
  const workbench = JSON.parse(
    readFileSync(join(here, "workbench-report.json"), "utf8"),
  );
  Object.assign(measured, {
    workbenchOpenMs: workbench.openCommandToSidebarMs,
    workbenchEchoP95Ms: workbench.echoP95Ms,
    workbenchIdleCpuPercent: workbench.idleCpuPercent,
    workbenchTerminalRerenders: workbench.terminalRerendersOnPatch,
  });
  const rows = Object.entries(budgets).map(([key, budget]) => {
    const value = measured[key];
    const ok =
      Number.isFinite(value) &&
      (budget.max === undefined || value <= budget.max) &&
      (budget.min === undefined || value >= budget.min);
    return {
      key,
      label: budget.label,
      budget:
        budget.max !== undefined ? `<= ${budget.max}` : `>= ${budget.min}`,
      measured: Number.isFinite(value) ? Number(value.toFixed(2)) : null,
      ok,
    };
  });

  const report = {
    at: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: (await import("node:os")).cpus().length,
      node: process.version,
    },
    workbench,
    listRows: LIST_ROWS,
    coldStartRunsMs: measured.coldStartRunsMs,
    extras: {
      terminalKeystrokeP50Ms: Number(
        measured.terminalKeystrokeP50Ms?.toFixed(2),
      ),
      terminalKeystrokeSamples: measured.terminalKeystrokeSamples,
    },
    rows,
    pass: rows.every((row) => row.ok),
  };
  writeFileSync(
    join(here, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const row of rows) {
    console.log(
      `${row.ok ? "ok  " : "FAIL"} ${row.label}: ${row.measured} (${row.budget})`,
    );
  }
  if (!report.pass) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await app?.close();
    } finally {
      await harness.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
