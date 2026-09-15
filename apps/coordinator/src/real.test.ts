// Opt-in, with `LOOM_REAL_PROVIDERS=1`: one real headless Claude planner, on the cheapest model,
// in a throwaway repository, driven by the real coordinator, executor, store and MCP server.
//
// What this does not cover, deliberately: GitHub. The merge half of the walking skeleton needs a
// throwaway GitHub repository and a token, which this test has no authority to create, so the
// GitHub adapter is still the fake one. The rest — the launch recipe, the per-run settings and MCP
// config, the hook receiver, `claude agents --json`, the MCP endpoint and the plan guard — is real.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "@loom/adapter-claude";
import { createGitAdapter } from "@loom/adapter-git";
import type { IsoTime, Repo, RepoId, WorktreePath } from "@loom/core";
import { FakeGitHub, FakePaneHost } from "@loom/fake-agent";
import { openStore } from "@loom/store";
import { expect, test } from "vitest";
import type { Adapters } from "./adapters.js";
import { configSchema, reconcileConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";

const enabled = process.env.LOOM_REAL_PROVIDERS === "1";
/** The cheapest model Loom will ever launch. Real-provider tests never use a larger one. */
const MODEL = "haiku";

test.skipIf(!enabled)(
  "a real headless Claude planner plans a real repository and submits through MCP",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), "loom-real-"));
    const repoRoot = join(root, "repo");
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Loom",
      GIT_AUTHOR_EMAIL: "loom@example.invalid",
      GIT_COMMITTER_NAME: "Loom",
      GIT_COMMITTER_EMAIL: "loom@example.invalid",
    };
    await exec("git", ["init", "-b", "main", repoRoot], { env });
    await writeFile(join(repoRoot, "example.txt"), "base\n");
    await writeFile(
      join(repoRoot, "WORKFLOW.md"),
      "## test\n```sh\necho ok\n```\n",
    );
    await exec("git", ["-C", repoRoot, "add", "."], { env });
    await exec("git", ["-C", repoRoot, "commit", "-m", "Base"], { env });

    const config = configSchema.parse({
      instance: "realtest",
      dataRoot: join(root, "data"),
      worktreeRoot: join(root, "worktrees"),
      bind: "127.0.0.1:0",
      token: "real-test-token-0123456789",
      models: { codex: MODEL, claude: MODEL },
      runModes: "planner=headless",
    });
    const store = await openStore({
      dataRoot: config.dataRoot,
      instance: config.instance,
      config: reconcileConfig(config),
    });
    const git = createGitAdapter();
    const repo: Repo = {
      id: "real-repo" as RepoId,
      root: (await git.realpath(repoRoot)) as WorktreePath,
      github: "example/repo",
    };
    store.putRepo(repo);
    const claude = await createClaudeAdapter({
      // Every Loom launch writes the run's own registration; this is only the fallback.
      mcpServer: { type: "http", url: "http://127.0.0.1:1/mcp" },
      log: store.hooks,
    });
    const clock = { now: () => new Date().toISOString() as IsoTime };
    const adapters: Adapters = {
      git,
      github: new FakeGitHub(
        { now: clock.now } as never,
        repo.github,
        "loom/pending",
        null,
      ),
      paneHost: new FakePaneHost(),
      claude,
      codex: async () => {
        throw new Error("This test launches no Codex run");
      },
      codexIfRunning: () => null,
      stopCodexServer: async () => {
        // No-op: this test doesn't launch Codex
      },
      codexServerCount: () => 0,
      codexServerRunning: () => false,
      close: async () => {
        await claude.close();
      },
    };
    const coordinator = new Coordinator({ config, store, adapters });
    await coordinator.start();
    try {
      const state = coordinator.createTask({
        repoId: repo.id,
        title: "Describe example.txt",
        description:
          "Write a plan for replacing the single line in example.txt with the word 'loom'.",
      });
      coordinator.submitHuman(state.task.id, { type: "move", to: "todo" });

      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        await coordinator.settle();
        const now = store.loadTaskState(state.task.id);
        if (now.plan || now.task.failed) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        coordinator.loop.enqueue(state.task.id);
      }

      const planned = store.loadTaskState(state.task.id);
      expect(planned.task.failed).toBeNull();
      expect(planned.plan?.goal).toBeTruthy();
      expect(planned.plan?.steps.length).toBeGreaterThan(0);
      // The run's session and its private files are Loom's, recorded before launch.
      const recipe = coordinator.recipes
        .all()
        .find((r) => r.role === "planner");
      expect(recipe?.sessionId).toBeTruthy();
      expect(recipe?.settingsPath).toBeTruthy();
      expect(recipe?.mcpConfigPath).toBeTruthy();
    } finally {
      await coordinator.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  360_000,
);
