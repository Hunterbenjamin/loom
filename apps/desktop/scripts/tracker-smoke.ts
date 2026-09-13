// Built-window smoke test against a disposable coordinator using only fake providers/host/GitHub.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { loadScenarios } from "../../../packages/fake-agent/src/index.js";
import {
  createHarness,
  ScenarioDriver,
} from "../../coordinator/src/test-support.js";

// Browser-only global inside Playwright's serialized callbacks.
declare const window: {
  loom: {
    store: {
      getState(): {
        connection: string;
        snapshot: { tasks: { stage: string }[] };
      };
    };
  };
};

const h = await createHarness({
  serveProtocol: true,
  config: { instance: "dev" },
});
const userData = await mkdtemp(join(tmpdir(), "loom-tracker-window-"));
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const state = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Approve the live Tracker smoke plan",
    description: "Fake-agent smoke check",
    requirePlanApproval: true,
  });
  h.coordinator.submitHuman(state.task.id, { type: "move", to: "todo" });
  const driver = new ScenarioDriver(
    h,
    await loadScenarios(
      new URL(
        "../../coordinator/src/fixtures/planner-ok.json",
        import.meta.url,
      ),
    ),
  );
  await driver.run({
    until: () =>
      h.store.loadTaskState(state.task.id).task.stage === "plan_approval",
  });
  await h.coordinator.settle();
  app = await electron.launch({
    args: [
      fileURLToPath(new URL("..", import.meta.url)),
      `--user-data-dir=${userData}`,
    ],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      LOOM_INSTANCE: "dev",
      LOOM_DATA_ROOT: h.config.dataRoot,
      LOOM_TOKEN: h.config.token,
      LOOM_BIND: new URL(h.coordinator.protocol.url as string).host,
    },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.waitForFunction(
      () => window.loom?.store.getState().connection === "connected",
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        errors,
        connection: await page.evaluate(
          () => window.loom?.store.getState().connection,
        ),
        text: await page.locator("body").innerText(),
      })}\n`,
    );
    throw error;
  }
  await page.keyboard.press("g");
  await page.keyboard.press("n");
  const row = page.locator('[data-reason="plan_needs_approval"]');
  await row.waitFor();
  if ((await page.title()) !== "Loom · 1 need you")
    throw new Error("Missing title count");
  await row.click();
  await page.locator('[data-tab-body="plan"]').waitFor();
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Queued by coordinator" })
    .waitFor();
  await h.coordinator.settle();
  await page.waitForFunction(
    () =>
      window.loom.store.getState().snapshot.tasks[0]?.stage !== "plan_approval",
  );
  const before = await page.evaluate(
    () => window.loom.store.getState().snapshot.tasks.length,
  );
  await h.coordinator.protocol.stop();
  await page.waitForFunction(
    () => window.loom.store.getState().connection === "disconnected",
  );
  if (
    (await page.evaluate(
      () => window.loom.store.getState().snapshot.tasks.length,
    )) !== before
  )
    throw new Error("Disconnect discarded the issue list");
  if (errors.length) throw new Error(errors.join("\n"));
  await page.screenshot({ path: join(tmpdir(), "loom-tracker-live.png") });
  process.stdout.write(
    "Tracker smoke passed: authenticated live snapshot, inbox shortcut, title badge, Plan routing, command ack, reconciled update, disconnected retention.\n",
  );
} finally {
  await app?.close();
  await h.close();
  await rm(userData, { recursive: true, force: true });
}
