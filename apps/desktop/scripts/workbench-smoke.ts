// Real attach clients and native inventory on an owned loom-test socket; providers remain fake.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createTmuxPaneHost } from "../../../packages/adapters/tmux/src/index.js";
import type {
  PaneRef,
  RunId,
  WorktreePath,
} from "../../../packages/core/src/index.js";
import { run } from "../../../packages/core/test/fixtures.js";
import { createHarness } from "../../coordinator/src/test-support.js";

declare const window: {
  loom: {
    store: { getState(): { connection: string } };
    terms?: Record<string, unknown>;
    terminalRenders?: Record<string, number>;
  };
  loomHost: {
    mode(): Promise<string>;
    openWindow(mode: string): Promise<void>;
  };
};
declare const document: {
  visibilityState: string;
  querySelectorAll(selector: string): { length: number };
  querySelector(selector: string): {
    addEventListener(name: string, fn: () => void, capture: boolean): void;
  } | null;
};
const temporary = await mkdtemp(join(tmpdir(), "loom-workbench-smoke-"));
const instance = `test-${process.pid}`;
const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
const host = createTmuxPaneHost({
  instance,
  tmuxExecutable: tmux,
  configPath: join(temporary, "tmux.conf"),
});
const h = await createHarness({ serveProtocol: true, config: { instance } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
const environment = {
  PATH: "/usr/bin:/bin",
  HOME: temporary,
  LANG: "en_US.UTF-8",
};
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ??
  Number.NaN;
function cpuSeconds(pid: number) {
  const pids = [pid];
  for (let i = 0; i < pids.length; i++) {
    try {
      pids.push(
        ...execFileSync("pgrep", ["-P", String(pids[i])], { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number),
      );
    } catch {}
  }
  return pids.reduce((sum, p) => {
    try {
      const parts = execFileSync("ps", ["-o", "cputime=", "-p", String(p)], {
        encoding: "utf8",
      })
        .trim()
        .split(":")
        .map(Number);
      return (
        sum + (parts.length === 2 ? (parts[0] ?? 0) * 60 + (parts[1] ?? 0) : 0)
      );
    } catch {
      return sum;
    }
  }, 0);
}
try {
  console.log("Workbench: creating 30 owned fixture panes");
  Object.assign(h.paneHost, host);
  const state = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Workbench fixture task",
    description: "No real agents",
  });
  await h.coordinator.settle();
  const workspace = await host.ensureWorkspace({
    taskId: state.task.id,
    cwd: temporary as WorktreePath,
    label: "fixture",
  });
  const refs: PaneRef[] = [];
  for (let i = 0; i < 29; i++)
    refs.push(
      await host.ensurePane({
        workspaceId: workspace.workspaceId,
        runId: `fixture-${i}` as RunId,
        cwd: temporary as WorktreePath,
        executable: "/bin/sh",
        args: ["-c", i === 28 ? "exit 7" : "stty -echo -icanon; cat"],
        env: environment,
      }),
    );
  const stored = h.store.loadTaskState(state.task.id);
  const r = {
    ...run(),
    id: `${state.task.id}/implementer/0` as RunId,
    taskId: state.task.id,
    pane: refs[0] as PaneRef,
    worktreePath: temporary as WorktreePath,
    status: "blocked" as const,
    blockedOn: "permission" as const,
  };
  stored.task = {
    ...stored.task,
    version: stored.task.version + 1,
    worktreePath: temporary as WorktreePath,
  };
  stored.worktree = {
    path: temporary as WorktreePath,
    taskId: state.task.id,
    repoId: h.repo.id,
    branch: "fixture",
    baseBranch: "main",
    baseSha: "a".repeat(40) as never,
    portSlot: null,
    paneWorkspaceId: workspace.workspaceId,
    createdAt: stored.task.createdAt,
    removedAt: null,
    git: null,
  };
  stored.runs = [r];
  const committed = h.store.commit(
    state.task.id,
    { next: stored, actions: [], inputs: [], transitions: [] },
    stored.task.version - 1,
  );
  assert.equal(committed.ok, true);
  await sleep(2200);
  console.log("Workbench: launching desktop");
  app = await electron.launch({
    args: [
      fileURLToPath(new URL("..", import.meta.url)),
      `--user-data-dir=${join(temporary, "electron")}`,
    ],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      LOOM_INSTANCE: instance,
      LOOM_TOKEN: h.config.token,
      LOOM_BIND: new URL(h.coordinator.protocol.url as string).host,
      LOOM_DATA_ROOT: h.config.dataRoot,
      LOOM_WINDOW_MODE: "tracker",
      LOOM_ATTACH_PANE: "",
      LOOM_EXIT_WHEN_INTERACTIVE: "",
    },
  });
  app.process().stderr?.on("data", (data) => process.stderr.write(data));
  const tracker = await app.firstWindow();
  await tracker.waitForFunction(
    () => window.loom?.store.getState().connection === "connected",
  );
  await tracker.waitForSelector(".bottom-bar");
  // The live desktop keeps one empty Workbench prepared; measure command-to-usable presentation.
  const warmStart = Date.now();
  const page =
    app.windows().find((p) => p !== tracker) ??
    (await app.waitForEvent("window"));
  await page.waitForFunction(
    () => document.querySelectorAll(".wb-agent").length === 30,
  );
  console.log("Workbench: prepared sidebar ready");
  const preparationMs = Date.now() - warmStart;
  const native = await app.browserWindow(page);
  assert.equal(await native.evaluate((w) => w.isVisible()), false);
  await tracker.bringToFront();
  const started = Date.now();
  const trackerNative = await app.browserWindow(tracker);
  await trackerNative.evaluate((w) => {
    w.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "W",
      modifiers: ["meta", "shift"],
    });
    w.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "W",
      modifiers: ["meta", "shift"],
    });
  });
  while (!(await native.evaluate((w) => w.isVisible()))) {
    assert.ok(
      Date.now() - started < 10000,
      "Workbench shortcut did not show the window",
    );
    await sleep(5);
  }
  const openMs = Date.now() - started;
  console.log(`Workbench: opened in ${openMs}ms`);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  assert.equal(await tracker.evaluate(() => window.loomHost.mode()), "tracker");
  assert.equal(await page.evaluate(() => window.loomHost.mode()), "workbench");
  assert.equal(await page.locator(".wb-agent.dead").count(), 1);
  const target = page
    .locator(".wb-agent")
    .filter({ hasText: "implementer" })
    .first();
  await page
    .getByRole("textbox", { name: "Find agent" })
    .fill("hidden-by-fixture-filter");
  assert.equal(await page.locator(".wb-agent").count(), 0);
  await page
    .getByRole("button", { name: "Agents needing attention · 1", exact: true })
    .click();
  assert.equal(
    await page.getByRole("textbox", { name: "Find agent" }).inputValue(),
    "",
  );
  await target.click();
  await page.waitForFunction(
    () => Object.keys(window.loom.terms ?? {}).length === 1,
  );
  const prefix = async (key: string) => {
    await page.keyboard.press("Control+a");
    await page.keyboard.press(key);
  };
  await prefix("|");
  await prefix("-");
  await prefix("|");
  await page.waitForFunction(
    () => Object.keys(window.loom.terms ?? {}).length === 4,
  );
  await sleep(1200);
  const before = await page.evaluate(() => ({
    ids: Object.keys(window.loom.terms ?? {}),
    renders: { ...window.loom.terminalRenders },
  }));
  execFileSync(tmux, [
    "-L",
    `loom-${instance}`,
    "select-pane",
    "-t",
    (refs[0] as PaneRef).paneId,
    "-T",
    "updated fixture title",
  ]);
  await sleep(2200);
  assert.deepEqual(
    await page.evaluate(() => window.loom.terminalRenders),
    before.renders,
    "pane patch rerendered terminals",
  );
  await prefix("z");
  await prefix("z");
  await prefix("c");
  await prefix("p");
  assert.deepEqual(
    await page.evaluate(() => Object.keys(window.loom.terms ?? {})),
    before.ids,
    "layout interaction remounted terminals",
  );
  await sleep(100); // Let the tab layout paint before grabbing a resize handle.
  const sash = page.locator(".wb-tab:visible .dv-sash.dv-enabled").first();
  const sashBox = await sash.boundingBox();
  assert.ok(sashBox, "split resize handle missing");
  const panelsBeforeResize = await page
    .locator(".wb-tab:visible [data-panel]")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return [r.width, r.height];
      }),
    );
  await page.mouse.move(
    sashBox.x + sashBox.width / 2,
    sashBox.y + sashBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sashBox.x + sashBox.width / 2 + 45,
    sashBox.y + sashBox.height / 2 + 45,
    { steps: 5 },
  );
  await page.mouse.up();
  await sleep(200);
  const panelsAfterResize = await page
    .locator(".wb-tab:visible [data-panel]")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return [r.width, r.height];
      }),
    );
  assert.notDeepEqual(
    panelsAfterResize,
    panelsBeforeResize,
    "dragging the sash did not resize panels",
  );
  await page
    .locator(`[data-panel="${before.ids[0]}"] header`)
    .dragTo(page.locator(`[data-panel="${before.ids[1]}"]`), {
      targetPosition: { x: 10, y: 60 },
    });
  assert.deepEqual(
    await page.evaluate(() => Object.keys(window.loom.terms ?? {})),
    before.ids,
    "drag remounted terminals",
  );
  // Four mounted panels, one owned raw-echo shell. Time keydown to xterm's write-parsed callback.
  const samples: number[] = [];
  for (const id of before.ids) {
    await page.evaluate((id) => {
      const terminal = window.loom.terms?.[id] as {
        focus(): void;
        onWriteParsed(fn: () => void): { dispose(): void };
      };
      const textarea = document.querySelector(
        `[data-panel="${id}"] textarea`,
      ) as NonNullable<ReturnType<typeof document.querySelector>>;
      const timings = { sent: [] as number[], deltas: [] as number[] };
      (window as unknown as { timings: typeof timings }).timings = timings;
      textarea.addEventListener(
        "keydown",
        () => timings.sent.push(performance.now()),
        true,
      );
      terminal.onWriteParsed(() => {
        const at = timings.sent.shift();
        if (at !== undefined) timings.deltas.push(performance.now() - at);
      });
      terminal.focus();
    }, id);
    for (let n = 0; n < 10; n++) {
      await page.keyboard.press("KeyX");
      await sleep(80);
    }
    samples.push(
      ...(await page.evaluate(
        () =>
          (window as unknown as { timings: { deltas: number[] } }).timings
            .deltas,
      )),
    );
  }
  assert.equal(samples.length, 40, "missing echo samples");
  await prefix("|");
  await prefix("-");
  await page.waitForFunction(
    () => Object.keys(window.loom.terms ?? {}).length === 6,
  );
  await sleep(2000);
  const cpuBefore = cpuSeconds(app.process().pid as number);
  const cpuStart = Date.now();
  await sleep(5000);
  const idleCpu =
    ((cpuSeconds(app.process().pid as number) - cpuBefore) /
      ((Date.now() - cpuStart) / 1000)) *
    100;
  console.log("Workbench: layout, echo and idle samples complete");
  // Independent second window: closing the first leaves its client and the shell alive.
  const second =
    app.windows().find((p) => p !== tracker && p !== page) ??
    (await app.waitForEvent("window"));
  await page.getByRole("button", { name: "Workbench ⌘⇧W" }).click();

  await second.waitForFunction(
    () => document.querySelectorAll(".wb-agent").length === 30,
  );
  await second
    .locator(".wb-agent")
    .filter({ hasText: "implementer" })
    .first()
    .click();
  await sleep(500);
  await page.close();
  await sleep(500);
  assert.equal((await host.getPane(refs[0] as PaneRef))?.dead, false);
  assert.equal(
    Object.keys(await second.evaluate(() => window.loom.terms ?? {})).length,
    1,
  );
  await second
    .getByRole("button", { name: "Scratch shell", exact: true })
    .click();
  await second.waitForFunction(
    () => document.querySelectorAll(".wb-agent").length === 31,
  );
  await second.waitForFunction(
    () => Object.keys(window.loom.terms ?? {}).length === 2,
  );
  await second
    .locator(".wb-tab:visible .terminal-bar")
    .getByText(/^pid /)
    .waitFor({ state: "attached" });
  const scratch = (await host.listPanes()).find((p) =>
    p.windowName?.startsWith("scratch-"),
  );
  assert.ok(scratch, "scratch pane missing");
  assert.equal(scratch.startCwd, await realpath(temporary));
  await second
    .locator(".wb-tab:visible")
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  assert.equal(
    (await host.getPane(scratch.ref))?.dead,
    false,
    "closing scratch panel stopped the shell",
  );
  assert.deepEqual(errors, []);
  const report = {
    at: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      node: process.version,
      tmux: execFileSync(tmux, ["-V"], { encoding: "utf8" }).trim(),
    },
    inventory: 30,
    preparationMs,
    openCommandToSidebarMs: openMs,
    echoSamplesMs: samples,
    echoP95Ms: percentile(samples, 0.95),
    idleTerminals: 6,
    idleWallSeconds: 5,
    idleCpuPercent: idleCpu,
    terminalRerendersOnPatch: 0,
    pass: openMs <= 300 && percentile(samples, 0.95) <= 16 && idleCpu <= 3,
  };
  await writeFile(
    new URL("../perf/workbench-report.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
  assert.equal(report.pass, true, "Workbench performance budget failed");
} finally {
  await app?.close();
  await h.close();
  try {
    execFileSync(tmux, ["-L", `loom-${instance}`, "kill-server"]);
  } catch {}
  await rm(temporary, { recursive: true, force: true });
}
