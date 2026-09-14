import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createClaudeAdapter } from "@loom/adapter-claude";
import type { HumanCommand, ProviderSessionId } from "@loom/core";
import { leadToolNames } from "@loom/mcp";
import { openStore } from "@loom/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test, vi } from "vitest";
import { LoomClient } from "./client.js";
import { reconcileConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { inspectTask } from "./inspect.js";
import { createHarness, type Harness } from "./test-support.js";

const present = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function setup() {
  const h = await createHarness({
    serveProtocol: true,
    config: { leadModel: "fake-lead-model" },
  });
  cleanups.push(() => h.close());
  const cli = await LoomClient.connect({
    url: present(h.coordinator.protocol.url),
    token: h.config.token,
    clientId: "lead-test-cli",
    kind: "cli",
  });
  cleanups.push(async () => cli.close());
  return { h, cli };
}
const recipe = async (h: Harness) =>
  JSON.parse(
    await readFile(
      join(h.store.dataDirectory, `lead/${h.repo.id}/recipe.json`),
      "utf8",
    ),
  );
async function mcp(h: Harness) {
  const saved = await recipe(h);
  const client = new Client({ name: "test-lead", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(present(h.coordinator.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${saved.token}` } },
    }),
  );
  cleanups.push(() => client.close());
  return client;
}

test("concurrent open commands are idempotent, private, and separate from task runs", async () => {
  const { h, cli } = await setup();
  // Exercise production argv construction while the pane host and provider remain fake.
  const adapter = await createClaudeAdapter({
    mcpServer: { command: "fake", args: [] },
  });
  cleanups.push(() => adapter.close());
  h.adapters.claude.interactiveArgs = adapter.interactiveArgs;
  const savedBeforeLaunch: unknown[] = [];
  const ensure = h.paneHost.ensurePane.bind(h.paneHost);
  h.paneHost.ensurePane = async (request) => {
    savedBeforeLaunch.push(await recipe(h));
    return ensure(request);
  };
  const [a, b] = await Promise.all([
    cli.command({ kind: "open_lead_session", repoId: h.repo.id }),
    cli.command({ kind: "open_lead_session", repoId: h.repo.id }),
  ]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    ok: true,
    result: {
      kind: "attach_session",
      target: { identity: "lead", attach: { env: {} } },
    },
  });
  expect(h.paneHost.launches).toHaveLength(1);
  expect(h.store.tasks()).toEqual([]);
  expect(h.coordinator.recipes.all()).toEqual([]);
  const saved = await recipe(h);
  expect(savedBeforeLaunch).toMatchObject([
    { sessionId: saved.sessionId, model: "fake-lead-model" },
  ]);
  expect(saved.cwd).toBe(h.repo.root);
  // Main is the brain with hands: no tool allowlist, no restricted mode, no strict MCP config.
  expect(saved.args).not.toContain("--disallowedTools");
  expect(saved.args).not.toContain("--tools");
  expect(saved.args).not.toContain("--restricted");
  expect(saved.args).not.toContain("--strict-mcp-config");
  expect(saved.args[saved.args.indexOf("--permission-mode") + 1]).toBe(
    "bypassPermissions",
  );
  expect(saved.args.at(-2)).toBe("--");
  expect(h.paneHost.launches[0]?.args).toEqual(saved.args);
  expect(saved.args.join(" ")).toContain("with hands");
  expect(saved.args.join(" ")).not.toContain(saved.token);
  expect(
    (await stat(join(h.store.dataDirectory, `lead/${h.repo.id}/recipe.json`)))
      .mode & 0o777,
  ).toBe(0o600);
  expect(h.paneHost.launches[0]?.workspaceId).toBe(`loom-lead-${h.repo.id}`);
  const client = await mcp(h);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
    leadToolNames,
  );
  expect(
    await cli.command({ kind: "stop_lead_session", repoId: h.repo.id }),
  ).toMatchObject({
    ok: true,
    result: { kind: "lead_stopped" },
  });
  expect(
    (await client.callTool({ name: "list_tasks", arguments: {} })).isError,
  ).toBe(true);
  await cli.command({ kind: "open_lead_session", repoId: h.repo.id });
  expect((await recipe(h)).sessionId).not.toBe(saved.sessionId);
  expect(h.paneHost.launches).toHaveLength(2);
});

test("Main tools share the CLI command path and inspection view; core still rejects invalid approvals", async () => {
  const { h, cli } = await setup();
  await cli.command({ kind: "open_lead_session", repoId: h.repo.id });
  const client = await mcp(h);
  const call = async (name: string, input: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: input })).structuredContent;
  const fields = {
    repoId: h.repo.id,
    title: "Delegated work",
    name: "Delegated work",
    description: "Use a task",
    summary: "Delegate work through a Loom task",
    providers: null,
    requirePlanApproval: null,
    blockedBy: [],
    budgetMinutes: null,
  };
  const created = await call("create_task", fields);
  const task = present(h.store.tasks()[0]);
  expect(created).toMatchObject({
    ok: true,
    value: { ok: true, result: { kind: "task_created", taskId: task.id } },
  });
  expect(await call("list_tasks", {})).toEqual({
    ok: true,
    value: h.store.tasks().map((task) => ({
      ...task,
      issue: "REPO-1",
      displayName: "Delegated work",
    })),
  });
  expect(await call("list_repos", {})).toEqual({
    ok: true,
    value: h.store.repos(),
  });
  expect(await call("inspect_task", { taskId: "repo-1" })).toEqual({
    ok: true,
    value: inspectTask(h.store, task.id, h.adapters),
  });
  const submit = vi.spyOn(h.coordinator, "submitHuman");
  const commands: [string, HumanCommand][] = [
    ["approve_plan", { type: "approve_plan", planVersion: 3 }],
    ["reject_plan", { type: "reject_plan", feedback: "Clarify scope" }],
    ["approve_merge", { type: "approve", headSha: "a".repeat(40) as never }],
    [
      "request_changes",
      {
        type: "request_changes",
        findings: [
          {
            id: "finding" as never,
            severity: "major",
            title: "Fix",
            body: "Fix this",
            anchor: null,
          },
        ],
      },
    ],
    [
      "answer_question",
      {
        type: "answer_question",
        questionId: "question" as never,
        answer: "Yes",
      },
    ],
    [
      "answer_provider_request",
      {
        type: "answer_provider_request",
        runId: "run" as never,
        requestId: "request",
        generation: null,
        decision: "decline",
        answers: null,
      },
    ],
    ["retry_task", { type: "retry" }],
    ["cancel_task", { type: "cancel", reason: "Not needed" }],
    ["move_task", { type: "move", to: "todo" }],
  ];
  for (const [index, [name, command]] of commands.entries()) {
    const { type: _, ...input } = command;
    await call(name, { taskId: index % 2 ? "1" : "REPO-1", ...input });
    expect(submit).toHaveBeenLastCalledWith(task.id, command);
    await cli.command({ kind: "human", taskId: task.id, command });
    expect(submit).toHaveBeenLastCalledWith(task.id, command);
  }
  await h.coordinator.settle();
  expect(h.store.loadTaskState(task.id).approvals).toEqual([]);
});

for (const condition of ["live", "dead", "absent", "stopped"] as const)
  test(`restart preserves identity and MCP endpoint; ${condition} pane follows recovery policy`, async () => {
    const { h } = await setup();
    const first = await h.coordinator.leadFor(h.repo.id).open();
    const saved = await recipe(h);
    const url = present(h.coordinator.mcpUrl).toString();
    const sessionId = saved.sessionId as ProviderSessionId;
    h.providers.create(
      "claude",
      h.repo.root as never,
      sessionId,
      "interactive",
    );
    if (condition === "dead")
      h.paneHost.exit(
        { ...present(first.pane), windowId: first.pane?.windowId as string },
        1,
      );
    if (condition === "absent") h.paneHost.restart();
    if (condition === "stopped") await h.coordinator.leadFor(h.repo.id).stop();
    await h.coordinator.stop();
    const store = await openStore({
      dataRoot: h.dataRoot,
      instance: h.config.instance,
      config: reconcileConfig(h.config),
    });
    const second = new Coordinator({
      config: h.config,
      store,
      adapters: h.adapters,
      serveProtocol: false,
    });
    cleanups.push(() => second.stop());
    await second.start();
    expect(present(second.mcpUrl).toString()).toBe(url);
    expect(second.leadFor(h.repo.id).sessionId).toBe(sessionId);
    expect(h.paneHost.launches).toHaveLength(condition === "dead" ? 2 : 1);
    if (condition === "dead")
      expect(h.paneHost.launches[1]?.args).toContain("--resume");
    if (condition === "live")
      expect((await second.leadFor(h.repo.id).open()).pane?.paneId).toBe(
        first.pane?.paneId,
      );
    if (condition === "absent") {
      await second.leadFor(h.repo.id).open();
      expect(h.paneHost.launches).toHaveLength(2);
    }
    expect(second.resolveRunToken(saved.token)).toBeNull();
    expect(second.leadFor(h.repo.id).resolve(saved.token)?.active).toBe(
      condition !== "stopped",
    );
  });

test("Main status comes from the provider entry and a matching cwd", async () => {
  const { h } = await setup();
  const target = await h.coordinator.leadFor(h.repo.id).open();
  expect((await h.coordinator.leadFor(h.repo.id).state()).status).toBe(
    "unknown",
  );
  h.providers.create(
    "claude",
    h.repo.root as never,
    present(target.sessionId),
    "interactive",
  );
  for (const [provider, expected] of [
    ["idle", "idle"],
    ["busy", "working"],
    ["waiting", "waiting"],
  ] as const) {
    h.adapters.claude.listSessions = async () => [
      {
        sessionId: present(target.sessionId),
        cwd: h.repo.root as never,
        status: provider,
        rawStatus: provider,
        kind: "interactive",
        pid: 1,
      },
    ];
    expect((await h.coordinator.leadFor(h.repo.id).state()).status).toBe(
      expected,
    );
  }
});

test("a lost pane receipt is recovered by explicit open, never by adopting the workspace's human shell", async () => {
  const { h } = await setup();
  const cwd = h.repo.root as never;
  const { workspaceId } = await h.paneHost.ensureWorkspace({
    taskId: `lead-${h.repo.id}` as never,
    cwd,
    label: "Main",
  });
  const shell = await h.paneHost.ensurePane({
    workspaceId,
    runId: "human-shell" as never,
    cwd,
    executable: "fake-shell",
    args: [],
    env: {},
  });
  const ensure = h.paneHost.ensurePane.bind(h.paneHost);
  let drop = true;
  h.paneHost.ensurePane = async (request) => {
    const ref = await ensure(request);
    if (drop) {
      drop = false;
      throw new Error("Lost launch receipt");
    }
    return ref;
  };
  await expect(h.coordinator.leadFor(h.repo.id).open()).rejects.toThrow(
    "Lost launch receipt",
  );
  expect((await recipe(h)).pane).toBeNull();
  await h.coordinator.leadFor(h.repo.id).recover();
  expect(h.paneHost.launches).toHaveLength(2);
  await expect(h.coordinator.leadFor(h.repo.id).stop()).rejects.toThrow(
    "Open Main",
  );
  const target = await h.coordinator.leadFor(h.repo.id).open();
  expect(target.pane?.paneId).not.toBe(shell.paneId);
  expect(h.paneHost.launches).toHaveLength(2);
  await h.coordinator.leadFor(h.repo.id).stop();
  expect((await h.paneHost.getPane(shell))?.dead).toBe(false);
  await h.coordinator.leadFor(h.repo.id).open();
  expect(h.paneHost.launches).toHaveLength(3);
  expect((await h.paneHost.getPane(shell))?.dead).toBe(false);
});

test("configured MCP port wins over the Main recipe and recovery refreshes both session types", async () => {
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const saved = await recipe(h);
  const task = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Recovery test",
    description: "Fake planner",
  });
  h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const runRecipe = present(
    h.coordinator.recipes.all().find((r) => r.provider === "claude"),
  );

  // Reserve a different port while the old endpoint is still listening, then test its busy error.
  const listener = createServer();
  const closeListener = () =>
    new Promise<void>((resolve, reject) => {
      if (!listener.listening) return resolve();
      listener.close((error) => (error ? reject(error) : resolve()));
    });
  cleanups.push(closeListener);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const mcpPort = address.port;
  expect(mcpPort).not.toBe(saved.mcpPort);
  await h.coordinator.stop();
  const config = { ...h.config, mcpPort };
  const store = await openStore({
    dataRoot: h.dataRoot,
    instance: config.instance,
    config: reconcileConfig(config),
  });
  const second = new Coordinator({
    config,
    store,
    adapters: h.adapters,
    serveProtocol: false,
  });
  cleanups.push(() => second.stop());
  const settings = vi.spyOn(h.adapters.claude, "writeSettings");
  await expect(second.start()).rejects.toThrow(
    `Port ${mcpPort} is in use; set LOOM_MCP_PORT`,
  );
  await closeListener();
  await second.start();
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  expect(second.mcpUrl?.toString()).toBe(url);
  for (const settingsPath of [saved.settingsPath, runRecipe.settingsPath])
    expect(settings).toHaveBeenCalledWith(
      settingsPath,
      expect.objectContaining({ type: "http", url }),
    );
  expect(second.leadFor(h.repo.id).sessionId).toBe(saved.sessionId);
  expect(
    h.paneHost.launches.filter(
      (launch) => launch.runId === `lead-${h.repo.id}`,
    ),
  ).toHaveLength(1);
});

test("Main note is bounded, private, instance-scoped and survives rotation and coordinator restart", async () => {
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const first = await recipe(h);
  const client = await mcp(h);
  const note = "Focus on conversation and delegate the release investigation.";
  expect(
    await client.callTool({ name: "set_note", arguments: { note } }),
  ).toMatchObject({
    structuredContent: { ok: true, value: { recorded: true } },
  });
  expect(await h.coordinator.leadFor(h.repo.id).note()).toBe(note);
  expect(
    (await stat(join(h.store.dataDirectory, `lead/${h.repo.id}/main-notes`)))
      .mode & 0o777,
  ).toBe(0o600);
  expect(
    (
      await client.callTool({
        name: "set_note",
        arguments: { note: "x".repeat(2001) },
      })
    ).isError,
  ).toBe(true);
  expect(await h.coordinator.leadFor(h.repo.id).note()).toBe(note);
  await h.coordinator.leadFor(h.repo.id).stop();
  expect(
    (await client.callTool({ name: "set_note", arguments: { note: "stale" } }))
      .isError,
  ).toBe(true);
  await h.coordinator.stop();
  const store = await openStore({
    dataRoot: h.dataRoot,
    instance: h.config.instance,
    config: reconcileConfig(h.config),
  });
  const second = new Coordinator({
    config: h.config,
    store,
    adapters: h.adapters,
    serveProtocol: false,
  });
  cleanups.push(() => second.stop());
  await second.start();
  await second.leadFor(h.repo.id).open();
  const saved = JSON.parse(
    await readFile(
      join(store.dataDirectory, `lead/${h.repo.id}/recipe.json`),
      "utf8",
    ),
  );
  expect(saved.sessionId).not.toBe(first.sessionId);
  expect(saved.args.at(-1)).toContain(note);
  expect(await second.leadFor(h.repo.id).note()).toBe(note);
  const { h: other } = await setup();
  expect(await other.coordinator.leadFor(other.repo.id).note()).toBe("");
  await second.leadFor(h.repo.id).setNote("");
  expect(await second.leadFor(h.repo.id).note()).toBe("");
});

test("opening a live Main sends it nothing, whatever its native status", async () => {
  const { h } = await setup();
  const paste = vi.spyOn(h.paneHost, "pasteText").mockResolvedValue("written");
  const target = await h.coordinator.leadFor(h.repo.id).open();
  expect(paste).not.toHaveBeenCalled();
  h.providers.create(
    "claude",
    h.repo.root as never,
    present(target.sessionId),
    "interactive",
  );
  const entry = {
    sessionId: present(target.sessionId),
    cwd: h.repo.root as never,
    status: "idle" as const,
    rawStatus: "idle",
    kind: "interactive" as const,
    pid: 1,
  };
  for (const status of ["idle", "busy", "waiting"] as const) {
    h.adapters.claude.listSessions = async () => [{ ...entry, status }];
    expect((await h.coordinator.leadFor(h.repo.id).open()).sessionId).toBe(
      target.sessionId,
    );
  }
  h.adapters.claude.listSessions = async () => {
    throw new Error("Provider unavailable");
  };
  expect((await h.coordinator.leadFor(h.repo.id).open()).sessionId).toBe(
    target.sessionId,
  );
  expect(paste).not.toHaveBeenCalled();
});

test("each repository has a private Main, scoped tools, notes and independent recovery", async () => {
  const { h, cli } = await setup();
  const other = {
    ...h.repo,
    root: h.dataRoot as typeof h.repo.root,
    id: "second" as typeof h.repo.id,
    github: "test/second",
  };
  h.store.putRepo(other);
  const a = await h.coordinator.leadFor(h.repo.id).open();
  const b = await h.coordinator.leadFor(other.id).open();
  const saved = await recipe(h);
  const secondSaved = JSON.parse(
    await readFile(
      join(h.store.dataDirectory, "lead/second/recipe.json"),
      "utf8",
    ),
  );
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(saved.token).not.toBe(secondSaved.token);
  expect(saved.args.at(-1)).toContain(h.repo.github);
  expect(secondSaved.args.at(-1)).toContain(other.github);
  expect(b.pane?.sessionName).toBe("loom-lead-second");
  await h.coordinator.leadFor(other.id).setNote("Second project only");
  expect(await h.coordinator.leadFor(h.repo.id).note()).toBe("");
  const foreign = h.coordinator.createTask({
    repoId: other.id,
    title: "Other",
    description: "Other project",
  });
  const client = await mcp(h);
  expect(
    (await client.callTool({ name: "list_tasks", arguments: {} }))
      .structuredContent,
  ).toEqual({ ok: true, value: [] });
  for (const name of ["inspect_task", "retry_task", "cancel_task"])
    await expect(
      client.callTool({
        name,
        arguments: {
          taskId: foreign.task.id,
          ...(name === "cancel_task" ? { reason: "test" } : {}),
        },
      }),
    ).rejects.toThrow("Loom host could not complete the request");
  expect(
    (
      await client.callTool({
        name: "create_task",
        arguments: {
          title: "Default",
          description: "Scoped",
          summary: "Default project",
          providers: null,
          requirePlanApproval: null,
          blockedBy: [],
          budgetMinutes: null,
        },
      })
    ).isError,
  ).not.toBe(true);
  expect(h.store.tasks().find((t) => t.title === "Default")?.repoId).toBe(
    h.repo.id,
  );
  await expect(
    client.callTool({
      name: "create_task",
      arguments: {
        repoId: other.id,
        title: "Wrong",
        description: "Wrong",
        summary: "Wrong project",
        providers: null,
        requirePlanApproval: null,
        blockedBy: [],
        budgetMinutes: null,
      },
    }),
  ).rejects.toThrow("Loom host could not complete the request");
  expect(
    h.store.tasks().find((task) => task.title === "Wrong"),
  ).toBeUndefined();
  await cli.command({ kind: "select_repo", repoId: other.id });
  expect(h.paneHost.launches).toHaveLength(2);
  for (const target of [a, b])
    h.paneHost.exit(
      {
        ...present(target.pane),
        windowId: present(target.pane).windowId as string,
      },
      1,
    );
  await h.coordinator.stop();
  const store = await openStore({
    dataRoot: h.dataRoot,
    instance: h.config.instance,
    config: reconcileConfig(h.config),
  });
  const restarted = new Coordinator({
    config: h.config,
    store,
    adapters: h.adapters,
    serveProtocol: false,
  });
  cleanups.push(() => restarted.stop());
  await restarted.start();
  expect(restarted.leadFor(h.repo.id).sessionId).toBe(a.sessionId);
  expect(restarted.leadFor(other.id).sessionId).toBe(b.sessionId);
  expect(h.paneHost.launches).toHaveLength(4);
  await restarted.leadFor(h.repo.id).stop();
  expect((await restarted.leadFor(other.id).open()).sessionId).toBe(
    b.sessionId,
  );
});

test("startup migrates the legacy recipe once to the first registered repository and keeps identity", async () => {
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  const { migrateLead } = await import("./lead.js");
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const saved = await recipe(h);
  await h.coordinator.leadFor(h.repo.id).stop();
  const { workspaceId } = await h.paneHost.ensureWorkspace({
    taskId: "lead" as never,
    cwd: h.store.dataDirectory as never,
    label: "Legacy Main",
  });
  const legacyPane = await h.paneHost.ensurePane({
    workspaceId,
    runId: "lead" as never,
    cwd: h.store.dataDirectory as never,
    executable: "fake",
    args: [],
    env: {},
  });
  h.providers.create(
    "claude",
    h.store.dataDirectory as never,
    saved.sessionId as ProviderSessionId,
    "interactive",
  );
  await h.coordinator.stop();
  const legacy = join(h.store.dataDirectory, "lead");
  await mkdir(legacy, { recursive: true });
  await rename(join(legacy, h.repo.id), join(h.dataRoot, "saved-main"));
  await writeFile(
    join(legacy, "recipe.json"),
    JSON.stringify({
      ...saved,
      cwd: h.store.dataDirectory,
      settingsPath: join(legacy, "settings.json"),
      pane: legacyPane,
    }),
  );
  await writeFile(
    join(h.store.dataDirectory, "main-notes"),
    "Retained context",
  );
  const store = await openStore({
    dataRoot: h.dataRoot,
    instance: h.config.instance,
    config: reconcileConfig(h.config),
  });
  const restarted = new Coordinator({
    config: h.config,
    store,
    adapters: h.adapters,
    serveProtocol: false,
  });
  cleanups.push(() => restarted.stop());
  await restarted.start();
  const migrated = await recipe(h);
  expect((await h.paneHost.getPane(legacyPane))?.dead).toBe(true);
  expect(migrated.pane.sessionName).toBe(`loom-lead-${h.repo.id}`);
  expect(migrated.args).toContain("--resume");
  const launches = h.paneHost.launches.length;
  expect(migrated).toMatchObject({
    sessionId: saved.sessionId,
    token: saved.token,
    cwd: h.repo.root,
    settingsPath: join(legacy, h.repo.id, "settings.json"),
  });
  expect(await restarted.leadFor(h.repo.id).note()).toBe("Retained context");
  await expect(readFile(join(legacy, "recipe.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await migrateLead(h.store.dataDirectory, h.repo);
  expect(await recipe(h)).toEqual(migrated);
  expect(h.paneHost.launches).toHaveLength(launches);
  // Simulate a crash after the destination commit but before retiring the source.
  await writeFile(join(legacy, "recipe.json"), JSON.stringify(saved));
  await migrateLead(h.store.dataDirectory, h.repo);
  expect(await recipe(h)).toEqual(migrated);
  expect(h.paneHost.launches).toHaveLength(launches);
});

async function messagingRun(
  h: Harness,
  provider: "claude" | "codex" = "claude",
) {
  const { task } = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Message target",
    description: "Fake run",
    size: "small",
    providers: { planner: provider, implementer: provider, reviewer: provider },
  });
  h.coordinator.submitHuman(task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const run = present(
    h.store.runs(task.id).find((r) => r.role === "implementer"),
  );
  h.providers.confirm(present(run.sessionId));
  h.coordinator.loop.enqueue(task.id);
  await h.coordinator.settle();
  return { task, run };
}

for (const provider of ["claude", "codex"] as const)
  test(`Main messages use core delivery and native ${provider} receipts, with durable concurrent dedupe`, async () => {
    const { h } = await setup();
    await h.coordinator.leadFor(h.repo.id).open();
    const client = await mcp(h);
    const { task, run } = await messagingRun(h, provider);
    const input = {
      to: { kind: "task", taskId: task.id, role: "implementer" },
      text: "Heads-up: the human is reviewing the requirements.",
      idempotencyKey: "heads-up",
    };
    const send = () =>
      client.callTool({ name: "message_agent", arguments: input });
    for (const result of await Promise.all([send(), send()]))
      expect(result.structuredContent).toEqual({
        ok: true,
        value: { delivered: "queued" },
      });
    expect(h.store.mainMessages.notes(task.id)).toMatchObject([
      { author: "main", body: input.text, outcome: "queued" },
    ]);
    await h.coordinator.settle();
    const message = present(
      h.store.messages(task.id).find((m) => m.text.includes(input.text)),
    );
    expect(message.status).toBe("sent");
    expect(
      h.store.outbox
        .list(task.id)
        .filter(
          (row) => row.kind === "send_message" && row.key.includes(message.id),
        ),
    ).toHaveLength(1);
    expect(h.providers.confirm(present(run.sessionId))?.text).toContain(
      input.text,
    );
    h.coordinator.loop.enqueue(task.id);
    await h.coordinator.settle();
    expect(
      h.store.messages(task.id).find((m) => m.id === message.id)?.status,
    ).toBe("delivered");
    expect((await send()).structuredContent).toEqual({
      ok: true,
      value: { delivered: "queued" },
    });
    expect(
      (
        await client.callTool({
          name: "message_agent",
          arguments: { ...input, text: "Different" },
        })
      ).structuredContent,
    ).toMatchObject({
      value: {
        delivered: "refused",
        reason: expect.stringContaining("idempotencyKey"),
      },
    });
    expect(
      h.store.messages(task.id).filter((m) => m.text.includes(input.text)),
    ).toHaveLength(1);
    expect(h.store.mainMessages.notes(task.id)).toHaveLength(1);
  });

for (const waiting of ["approval", "question"] as const)
  test(`Main refuses a run waiting on ${waiting} without writing to its provider`, async () => {
    const { h } = await setup();
    await h.coordinator.leadFor(h.repo.id).open();
    const client = await mcp(h);
    const { task, run } = await messagingRun(h);
    h.providers.request(present(run.sessionId), waiting, "Needs a decision");
    const writes = h.paneHost.writes.length;
    const input = {
      to: { kind: "run", taskId: task.id, runId: run.id },
      text: "Quick question",
      idempotencyKey: "waiting",
    };
    const response = await client.callTool({
      name: "message_agent",
      arguments: input,
    });
    expect(response.structuredContent).toMatchObject({
      value: {
        delivered: "refused",
        reason: expect.stringContaining(
          waiting === "approval" ? "permission" : "input",
        ),
      },
    });
    h.providers.answer(present(run.sessionId), "accept");
    expect(
      (await client.callTool({ name: "message_agent", arguments: input }))
        .structuredContent,
    ).toEqual(response.structuredContent);
    await h.coordinator.settle();
    expect(h.paneHost.writes).toHaveLength(writes);
    expect(
      h.store.messages(task.id).some((m) => m.text.includes(input.text)),
    ).toBe(false);
    expect(h.store.mainMessages.notes(task.id)).toMatchObject([
      { author: "main", body: input.text, outcome: "refused" },
    ]);
  });

test("Main refuses missing roles, ended runs and cross-repository destinations", async () => {
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const client = await mcp(h);
  const { task, run } = await messagingRun(h);
  const other = {
    ...h.repo,
    id: "other" as typeof h.repo.id,
    root: h.dataRoot as typeof h.repo.root,
    github: "example/other",
  };
  h.store.putRepo(other);
  const foreign = h.coordinator.createTask({
    repoId: other.id,
    title: "Private",
    description: "Other Main",
  });
  for (const to of [
    { kind: "task", taskId: task.id, role: "reviewer" },
    { kind: "run", taskId: task.id, runId: "missing" },
    { kind: "run", taskId: foreign.task.id, runId: run.id },
    { kind: "task", taskId: foreign.task.id, role: "implementer" },
  ])
    expect(
      (
        await client.callTool({
          name: "message_agent",
          arguments: { to, text: "Hello" },
        })
      ).structuredContent,
    ).toMatchObject({ value: { delivered: "refused" } });
  expect(h.store.mainMessages.notes(foreign.task.id)).toEqual([]);
  h.coordinator.submitHuman(task.id, {
    type: "cancel",
    reason: "Complete fixture",
  });
  await h.coordinator.settle();
  expect(
    (
      await client.callTool({
        name: "message_agent",
        arguments: {
          to: { kind: "run", taskId: task.id, runId: run.id },
          text: "Hello",
        },
      })
    ).structuredContent,
  ).toMatchObject({
    value: { delivered: "refused", reason: "the run has ended" },
  });
});

test("Main refuses a slow status read promptly and never queues a late send", async () => {
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const client = await mcp(h);
  const { task, run } = await messagingRun(h);
  const sessions = await h.adapters.claude.listSessions();
  let release: (value: typeof sessions) => void = () => {};
  const read = vi
    .spyOn(h.adapters.claude, "listSessions")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
  const start = performance.now();
  const result = await client.callTool({
    name: "message_agent",
    arguments: {
      to: { kind: "run", taskId: task.id, runId: run.id },
      text: "Slow check",
    },
  });
  expect(performance.now() - start).toBeLessThan(1500);
  expect(result.structuredContent).toMatchObject({
    value: {
      delivered: "refused",
      reason: "provider status was not available promptly",
    },
  });
  release(sessions);
  read.mockRestore();
  await h.coordinator.settle();
  expect(
    h.store.messages(task.id).some((m) => m.text.includes("Slow check")),
  ).toBe(false);
});

test("a permission appearing after Main admission still blocks the existing send path", async () => {
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const client = await mcp(h);
  const { task, run } = await messagingRun(h);
  const writes = h.paneHost.writes.length;
  const enqueue = h.store.enqueueInput.bind(h.store);
  const spy = vi
    .spyOn(h.store, "enqueueInput")
    .mockImplementation((taskId, input) => {
      if (input.type === "human" && input.command.type === "send_message")
        h.providers.request(
          present(run.sessionId),
          "approval",
          "Decision arrived during admission",
        );
      return enqueue(taskId, input);
    });
  expect(
    (
      await client.callTool({
        name: "message_agent",
        arguments: {
          to: { kind: "run", taskId: task.id, runId: run.id },
          text: "Race check",
        },
      })
    ).structuredContent,
  ).toMatchObject({ value: { delivered: "queued" } });
  spy.mockRestore();
  await h.coordinator.settle();
  expect(h.paneHost.writes).toHaveLength(writes);
  expect(
    h.store.messages(task.id).find((m) => m.text.includes("Race check"))
      ?.status,
  ).toBe("pending");
});

test("Main message receipts survive coordinator restart without Operator storage", async () => {
  const { h } = await setup();
  await h.coordinator.leadFor(h.repo.id).open();
  const { task, run } = await messagingRun(h);
  const client = await mcp(h);
  const input = {
    to: { kind: "run", taskId: task.id, runId: run.id },
    text: "Any context?",
    idempotencyKey: "restart-message",
  };
  await client.callTool({ name: "message_agent", arguments: input });
  await h.coordinator.settle();
  const restarted = await h.restart();
  cleanups.push(() => restarted.close());
  const nextClient = await mcp(restarted);
  expect(
    (await nextClient.callTool({ name: "message_agent", arguments: input }))
      .structuredContent,
  ).toMatchObject({ value: { delivered: "queued" } });
  expect(restarted.store.mainMessages.notes(task.id)).toHaveLength(1);
  expect(
    restarted.store
      .messages(task.id)
      .filter((m) => m.text.includes(input.text)),
  ).toHaveLength(1);
});
