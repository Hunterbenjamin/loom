import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskId } from "@loom/core";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "./cli.js";
import { LoomClient } from "./client.js";
import { createHarness, type Harness } from "./test-support.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

async function serve() {
  const h = await createHarness({
    serveProtocol: true,
    config: { instance: "dev" },
  });
  harness = h;
  const env = {
    LOOM_INSTANCE: h.config.instance,
    LOOM_DATA_ROOT: h.dataRoot,
    LOOM_TOKEN: h.config.token,
    LOOM_BIND: new URL(h.coordinator.protocol.url as string).host,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return { h, env };
}

test.each(["issue", "task"])(
  "pnpm loom task create stores a long quoted description without alteration",
  async (group) => {
    const { h, env } = await serve();
    const description = `${"  Preserve `printf fixture`, \"double quotes\", 'single quotes' (parentheses) and --flags. ".padEnd(
      1455,
      "x",
    )}  `;
    expect(description).toHaveLength(1457);
    // Pass an argv array: shell quoting is already resolved before the CLI receives it.
    const { stdout, stderr } = await promisify(execFile)(
      "pnpm",
      ["loom", group, "create", h.repo.id, "Long description", description],
      { env: { ...process.env, ...env }, timeout: 20_000 },
    );
    expect(stderr).toBe("");
    const created = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      taskId: TaskId;
    };
    expect(h.store.loadTaskState(created.taskId).task.description).toBe(
      description,
    );
  },
  30_000,
);

test("task create honors -- through the CLI entry point", async () => {
  const { h } = await serve();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await main([
    "task",
    "create",
    h.repo.id,
    "--",
    "--help",
    "--summary (literal)",
  ]);
  expect(h.store.tasks()).toContainEqual(
    expect.objectContaining({
      title: "--help",
      description: "--summary (literal)",
    }),
  );
}, 30_000);

test("CLI command and attach rejections print every detail", async () => {
  const { h } = await serve();
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Attach",
    description: "",
  });
  h.coordinator.submitHuman(created.task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const error = {
    code: "guard_failed" as const,
    message: "Cannot proceed",
    details: ["first guard", "second guard"],
  };
  vi.spyOn(LoomClient.prototype, "command").mockResolvedValue({
    ok: false,
    error,
  });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  await main(["task", "create", h.repo.id, "Rejected"]);
  expect(stderr).toHaveBeenLastCalledWith(
    "guard_failed: Cannot proceed\n  first guard\n  second guard\n",
  );
  stderr.mockClear();
  await main(["attach", created.task.id, "planner"]);
  expect(stderr).toHaveBeenLastCalledWith(
    "guard_failed: Cannot proceed\n  first guard\n  second guard\n",
  );
  expect(process.exitCode).toBe(1);
}, 30_000);

test("CLI prints frame validator paths for rejected input and creates no task", async () => {
  const { h } = await serve();
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  await main([
    "task",
    "create",
    h.repo.id,
    "x".repeat(201),
    "Valid description",
  ]);
  expect(stderr).toHaveBeenCalledWith(
    expect.stringMatching(
      /^invalid_frame: Frame failed the schema\n {2}command\.title: .+\n$/,
    ),
  );
  expect(process.exitCode).toBe(1);
  expect(h.store.tasks()).toHaveLength(0);
}, 30_000);

test("issue list, show and human commands use the existing protocol", async () => {
  const { h } = await serve();
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  await main(["issue", "list"]);
  expect(output).toBe("No issues.\n");
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Issue vocabulary",
    description: "",
  });
  await h.coordinator.settle();
  output = "";
  await main(["issue", "show", created.task.id]);
  expect(output).toContain(`${created.task.id}  Issue vocabulary`);
  const command = vi.spyOn(LoomClient.prototype, "command");
  await main(["issue", "cancel", created.task.id, "Finished"]);
  expect(command).toHaveBeenCalledWith({
    kind: "human",
    taskId: created.task.id,
    command: { type: "cancel", reason: "Finished" },
  });
}, 30_000);
