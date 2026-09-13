// Real Electron, coordinator and tmux. Only test-owned shells on a private socket; no agents.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createTmuxPaneHost } from "../../../packages/adapters/tmux/src/index.js";
import type { WorktreePath } from "../../../packages/core/src/index.js";
import { createHarness } from "../../coordinator/src/test-support.js";

declare const window: {
  loom: {
    store: {
      getState(): { connection: string; snapshot: { tasks: { id: string }[] } };
      open(id: string): void;
      setTab(tab: string): void;
    };
  };
  loomHost: { setMode(mode: string): Promise<void> };
};
const directory = await mkdtemp(join(tmpdir(), "loom-terminal-lifecycle-"));
const instance = `test-${process.pid}`;
const socket = `loom-${instance}`;
const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
const host = createTmuxPaneHost({
  instance,
  tmuxExecutable: tmux,
  configPath: join(directory, "tmux.conf"),
});
const h = await createHarness({ serveProtocol: true, config: { instance } });
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  Object.assign(h.paneHost, host);
  const first = await host.createScratch({
    workspaceId: "loom-workbench",
    createWorkspace: true,
    key: crypto.randomUUID(),
    label: "Existing shell",
    cwd: directory as WorktreePath,
    executable: "/bin/sh",
    args: [],
    env: { PATH: "/usr/bin:/bin", HOME: directory, TERM: "xterm-256color" },
  });
  app = await electron.launch({
    args: [
      fileURLToPath(new URL("..", import.meta.url)),
      `--user-data-dir=${join(directory, "electron")}`,
    ],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      LOOM_INSTANCE: instance,
      LOOM_TOKEN: h.config.token,
      LOOM_BIND: new URL(h.coordinator.protocol.url as string).host,
      LOOM_DATA_ROOT: h.config.dataRoot,
      LOOM_WINDOW_MODE: "workbench",
      LOOM_ATTACH_PANE: "",
      LOOM_EXIT_WHEN_INTERACTIVE: "",
    },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.loom?.store.getState().connection === "connected",
  );
  const row = (name: string) =>
    page.locator(".wb-terminal-list button").filter({ hasText: name });
  await row("Existing shell").waitFor();
  await row("Existing shell").click();
  await page
    .locator(".wb-tab:visible .terminal-bar")
    .getByText(/^pid /)
    .waitFor();
  assert.equal(await page.locator("dialog").count(), 0);
  await row("Existing shell").click();
  await row("Existing shell").press("Enter");
  assert.equal(
    await page.locator(".wb-tabs [aria-pressed]").count(),
    1,
    "selection created duplicate views",
  );
  assert.equal((await host.listPanes()).length, 1, "selection created a shell");
  await page
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
  await row("Existing shell").waitFor({ state: "detached" });
  assert.equal(
    await host.getPane(first),
    null,
    "close only detached the viewer",
  );
  assert.equal(await page.locator(".wb-tabs [aria-pressed]").count(), 0);
  await page.evaluate(() => window.loomHost.setMode("tracker"));
  await page.evaluate(() => window.loomHost.setMode("workbench"));
  assert.equal(
    (await host.listPanes()).length,
    0,
    "mode switch recreated a closed shell",
  );
  await page
    .locator(".wb-section-heading")
    .getByRole("button", { name: "New terminal", exact: true })
    .click();
  await page
    .getByLabel("Terminal name", { exact: true })
    .fill("Named terminal");
  await page
    .getByRole("button", { name: "Create terminal", exact: true })
    .click();
  await row("Named terminal").waitFor();
  await page
    .locator(".wb-tab:visible .terminal-bar")
    .getByText(/^pid /)
    .waitFor();
  const created = (await host.listPanes()).find(
    (p) => p.windowName === "Named terminal",
  );
  assert.ok(created);
  await page.evaluate(() => window.loomHost.setMode("tracker"));
  await page.evaluate(() => window.loomHost.setMode("workbench"));
  await row("Named terminal").click();
  await page
    .locator(".wb-tab:visible .terminal-bar")
    .getByText(/^pid /)
    .waitFor();
  assert.equal(
    (await host.listPanes()).length,
    1,
    "mode switch duplicated the open terminal",
  );
  assert.equal((await host.getPane(created.ref))?.dead, false);
  // Native process exit must remove the session from the UI, without a Close click.
  await page.locator(".wb-tab:visible .xterm-helper-textarea").focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await row("Named terminal").waitFor({ state: "detached", timeout: 10000 });
  assert.equal(await page.locator(".wb-tabs [aria-pressed]").count(), 0);
  await page.screenshot({ path: "/tmp/loom-terminal-lifecycle-verified.png" });
  await h.git("switch", "-c", "feat/terminal-branch-check");
  const task = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Issue terminal fixture",
    description: "No agent or worktree",
  });
  h.coordinator.submitHuman(task.task.id, {
    type: "cancel",
    reason: "closed fixture",
  });
  await h.coordinator.settle();
  await page.evaluate(() => window.loomHost.setMode("tracker"));
  await page.waitForFunction(
    (id) =>
      window.loom.store
        .getState()
        .snapshot.tasks.some((task) => task.id === id),
    task.task.id,
  );
  await page.evaluate((id) => {
    window.loom.store.open(id);
    window.loom.store.setTab("terminal");
  }, task.task.id);
  await page
    .locator(".terminal-tab .terminal-bar")
    .getByText(/^pid /)
    .waitFor();
  assert.equal(
    await page.locator("select[aria-label='Terminal run']").count(),
    0,
  );
  assert.match(
    await page.locator(".terminal-tab").innerText(),
    /Project root · feat\/terminal-branch-check/,
  );
  const fallback = (await host.listPanes()).find(
    (p) => p.windowName === `${task.task.id} terminal`,
  );
  assert.ok(fallback);
  assert.equal(fallback.startCwd, h.repo.root);
  await page.evaluate(() => window.loom.store.setTab("activity"));
  await page.evaluate(() => window.loom.store.setTab("terminal"));
  await page
    .locator(".terminal-tab .terminal-bar")
    .getByText(/^pid /)
    .waitFor();
  const reopened = (await host.listPanes()).filter(
    (p) => p.windowName === `${task.task.id} terminal`,
  );
  assert.deepEqual(
    reopened.map((p) => p.ref),
    [fallback.ref],
  );
  assert.equal(
    await h.git("branch", "--show-current"),
    "feat/terminal-branch-check",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: terminal lifecycle, automatic issue terminal, project root fallback, actual branch preserved, issue shell reuse",
  );
} finally {
  await app?.close();
  await h.close();
  try {
    execFileSync(tmux, ["-L", socket, "kill-server"]);
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
