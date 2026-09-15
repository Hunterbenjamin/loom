// Shared built-window data source. All workflow agents and GitHub are fake; optional
// terminals use only a private tmux server and shells owned by this harness.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createTmuxPaneHost } from "../../../packages/adapters/tmux/src/index.js";
import { loadScenarios } from "../../../packages/fake-agent/src/index.js";
import {
  createHarness,
  ScenarioDriver,
} from "../../coordinator/src/test-support.js";

export async function startDesktopHarness({
  count = 40,
  terminals = false,
} = {}) {
  const instance = `test-${process.pid}`;
  const h = await createHarness({ serveProtocol: true, config: { instance } });
  let tmux: string | undefined;
  let nativeHost: ReturnType<typeof createTmuxPaneHost> | undefined;
  const close = async () => {
    try {
      await h.close();
    } finally {
      if (nativeHost && tmux) {
        // ensureWorkspace starts this private server even if the window never opens a shell.
        execFileSync(tmux, ["-L", `loom-${instance}`, "kill-server"]);
      }
    }
  };
  try {
    const approval = h.coordinator.createTask({
      repoId: h.repo.id,
      title: "Review the desktop cleanup plan",
      description: "A sample issue driven by the fake planner.",
      requirePlanApproval: true,
    });
    h.coordinator.submitHuman(approval.task.id, { type: "move", to: "todo" });
    await new ScenarioDriver(
      h,
      await loadScenarios(
        new URL(
          "../../coordinator/src/fixtures/planner-ok.json",
          import.meta.url,
        ),
      ),
    ).run({
      until: () =>
        h.store.loadTaskState(approval.task.id).task.stage === "plan_approval",
    });
    const tasks = [];
    for (let index = 1; index < count; index++) {
      tasks.push(
        h.coordinator.createTask({
          repoId: h.repo.id,
          title: `Desktop sample issue ${index}`,
          description:
            "Deterministic performance and screenshot data in a disposable coordinator.",
        }).task,
      );
    }
    await h.coordinator.settle();
    if (terminals) {
      tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
      const host = createTmuxPaneHost({
        instance,
        tmuxExecutable: tmux,
        configPath: join(h.dataRoot, "tmux.conf"),
      });
      // Keep provider launches fake even when commands create real shell panes.
      // The fake planner has already finished before the native host is installed.
      const ensurePane = h.paneHost.ensurePane.bind(h.paneHost);
      await host.ensureWorkspace({
        taskId: approval.task.id,
        cwd: h.repo.root,
        label: "desktop-test",
      });
      nativeHost = host;
      Object.assign(h.paneHost, host, {
        ensurePane,
        createScratch: (request: Parameters<typeof host.createScratch>[0]) =>
          host.createScratch({
            ...request,
            executable: "/bin/sh",
            args: ["-l"],
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: h.dataRoot,
              LANG: "en_US.UTF-8",
            },
          }),
      });
    }
    return {
      h,
      host: nativeHost,
      approvalTaskId: approval.task.id,
      terminalTaskId: tasks[0]?.id ?? approval.task.id,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        LOOM_INSTANCE: instance,
        LOOM_DATA_ROOT: h.config.dataRoot,
        LOOM_TOKEN: h.config.token,
        LOOM_BIND: new URL(h.coordinator.protocol.url as string).host,
        LOOM_WINDOW_MODE: "tracker",
        LOOM_EXIT_WHEN_INTERACTIVE: "",
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
