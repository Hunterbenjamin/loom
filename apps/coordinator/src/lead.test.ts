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
    await readFile(join(h.store.dataDirectory, "lead/recipe.json"), "utf8"),
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
    cli.command({ kind: "open_lead_session" }),
    cli.command({ kind: "open_lead_session" }),
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
  expect(saved.cwd).toBe(h.store.dataDirectory);
  expect(
    saved.args[saved.args.indexOf("--disallowedTools") + 1].split(","),
  ).toEqual([
    "Bash",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
  ]);
  expect(saved.args[saved.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  expect(saved.args).toContain("--strict-mcp-config");
  expect(saved.args).not.toContain("bypassPermissions");
  expect(saved.args.at(-2)).toBe("--");
  expect(h.paneHost.launches[0]?.args).toEqual(saved.args);
  expect(saved.args.join(" ")).toContain("Always create Loom tasks");
  expect(saved.args.join(" ")).not.toContain(saved.token);
  expect(
    (await stat(join(h.store.dataDirectory, "lead/recipe.json"))).mode & 0o777,
  ).toBe(0o600);
  expect(h.paneHost.launches[0]?.workspaceId).toBe("loom-lead");
  const client = await mcp(h);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
    leadToolNames,
  );
  expect(await cli.command({ kind: "stop_lead_session" })).toMatchObject({
    ok: true,
    result: { kind: "lead_stopped" },
  });
  expect(
    (await client.callTool({ name: "list_tasks", arguments: {} })).isError,
  ).toBe(true);
  await cli.command({ kind: "open_lead_session" });
  expect((await recipe(h)).sessionId).not.toBe(saved.sessionId);
  expect(h.paneHost.launches).toHaveLength(2);
});

test("Main tools share the CLI command path and inspection view; core still rejects invalid approvals", async () => {
  const { h, cli } = await setup();
  await cli.command({ kind: "open_lead_session" });
  const client = await mcp(h);
  const call = async (name: string, input: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: input })).structuredContent;
  const fields = {
    repoId: h.repo.id,
    title: "Delegated work",
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
    value: h.store.tasks(),
  });
  expect(await call("list_repos", {})).toEqual({
    ok: true,
    value: h.store.repos(),
  });
  expect(await call("inspect_task", { taskId: task.id })).toEqual({
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
  for (const [name, command] of commands) {
    const { type: _, ...input } = command;
    await call(name, { taskId: task.id, ...input });
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
    const first = await h.coordinator.lead.open();
    const saved = await recipe(h);
    const url = present(h.coordinator.mcpUrl).toString();
    const sessionId = saved.sessionId as ProviderSessionId;
    h.providers.create(
      "claude",
      h.store.dataDirectory as never,
      sessionId,
      "interactive",
    );
    if (condition === "dead")
      h.paneHost.exit(
        { ...present(first.pane), windowId: first.pane?.windowId as string },
        1,
      );
    if (condition === "absent") h.paneHost.restart();
    if (condition === "stopped") await h.coordinator.lead.stop();
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
    expect(second.lead.sessionId).toBe(sessionId);
    expect(h.paneHost.launches).toHaveLength(condition === "dead" ? 2 : 1);
    if (condition === "dead")
      expect(h.paneHost.launches[1]?.args).toContain("--resume");
    if (condition === "live")
      expect((await second.lead.open()).pane?.paneId).toBe(first.pane?.paneId);
    if (condition === "absent") {
      await second.lead.open();
      expect(h.paneHost.launches).toHaveLength(2);
    }
    expect(second.resolveRunToken(saved.token)).toBeNull();
    expect(second.lead.resolve(saved.token)?.active).toBe(
      condition !== "stopped",
    );
  });

test("Main status comes from the provider entry and a matching cwd", async () => {
  const { h } = await setup();
  const target = await h.coordinator.lead.open();
  expect((await h.coordinator.lead.state()).status).toBe("unknown");
  h.providers.create(
    "claude",
    h.store.dataDirectory as never,
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
        cwd: h.store.dataDirectory as never,
        status: provider,
        rawStatus: provider,
        kind: "interactive",
        pid: 1,
      },
    ];
    expect((await h.coordinator.lead.state()).status).toBe(expected);
  }
});

test("a lost pane receipt is recovered by explicit open, never by adopting the workspace's human shell", async () => {
  const { h } = await setup();
  const cwd = h.store.dataDirectory as never;
  const { workspaceId } = await h.paneHost.ensureWorkspace({
    taskId: "lead" as never,
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
  await expect(h.coordinator.lead.open()).rejects.toThrow(
    "Lost launch receipt",
  );
  expect((await recipe(h)).pane).toBeNull();
  await h.coordinator.lead.recover();
  expect(h.paneHost.launches).toHaveLength(2);
  await expect(h.coordinator.lead.stop()).rejects.toThrow("Open Main");
  const target = await h.coordinator.lead.open();
  expect(target.pane?.paneId).not.toBe(shell.paneId);
  expect(h.paneHost.launches).toHaveLength(2);
  await h.coordinator.lead.stop();
  expect((await h.paneHost.getPane(shell))?.dead).toBe(false);
  await h.coordinator.lead.open();
  expect(h.paneHost.launches).toHaveLength(3);
  expect((await h.paneHost.getPane(shell))?.dead).toBe(false);
});

test("configured MCP port wins over the Main recipe and recovery refreshes both session types", async () => {
  const { h } = await setup();
  await h.coordinator.lead.open();
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
  expect(second.lead.sessionId).toBe(saved.sessionId);
  expect(
    h.paneHost.launches.filter((launch) => launch.runId === "lead"),
  ).toHaveLength(1);
});

test("Main note is bounded, private, instance-scoped and survives rotation and coordinator restart", async () => {
  const { h } = await setup();
  await h.coordinator.lead.open();
  const first = await recipe(h);
  const client = await mcp(h);
  const note = "Focus on conversation and delegate the release investigation.";
  expect(
    await client.callTool({ name: "set_note", arguments: { note } }),
  ).toMatchObject({
    structuredContent: { ok: true, value: { recorded: true } },
  });
  expect(await h.coordinator.lead.note()).toBe(note);
  expect(
    (await stat(join(h.store.dataDirectory, "main-notes"))).mode & 0o777,
  ).toBe(0o600);
  expect(
    (
      await client.callTool({
        name: "set_note",
        arguments: { note: "x".repeat(2001) },
      })
    ).isError,
  ).toBe(true);
  expect(await h.coordinator.lead.note()).toBe(note);
  await h.coordinator.lead.stop();
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
  await second.lead.open();
  const saved = JSON.parse(
    await readFile(join(store.dataDirectory, "lead/recipe.json"), "utf8"),
  );
  expect(saved.sessionId).not.toBe(first.sessionId);
  expect(saved.args.at(-1)).toContain(note);
  expect(await second.lead.note()).toBe(note);
  const { h: other } = await setup();
  expect(await other.coordinator.lead.note()).toBe("");
  await second.lead.setNote("");
  expect(await second.lead.note()).toBe("");
});

test("opening Main requests a brief summary only when native status permits input", async () => {
  const { h } = await setup();
  const paste = vi.spyOn(h.paneHost, "pasteText").mockResolvedValue("written");
  const target = await h.coordinator.lead.open();
  expect(paste).not.toHaveBeenCalled();
  h.providers.create(
    "claude",
    h.store.dataDirectory as never,
    present(target.sessionId),
    "interactive",
  );
  const entry = {
    sessionId: present(target.sessionId),
    cwd: h.store.dataDirectory as never,
    status: "idle" as const,
    rawStatus: "idle",
    kind: "interactive" as const,
    pid: 1,
  };
  h.adapters.claude.listSessions = async () => [entry];
  await h.coordinator.lead.open();
  expect(paste).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.stringContaining("Needs-you"),
  );
  paste.mockClear();
  for (const status of ["busy", "waiting"] as const) {
    h.adapters.claude.listSessions = async () => [{ ...entry, status }];
    await h.coordinator.lead.open();
  }
  h.adapters.claude.listSessions = async () => [
    { ...entry, cwd: "/unrelated" as never },
  ];
  await h.coordinator.lead.open();
  expect(paste).not.toHaveBeenCalled();
  h.adapters.claude.listSessions = async () => [entry];
  const hooks = await h.adapters.claude.hookSummary(entry.sessionId);
  h.adapters.claude.hookSummary = async () => ({
    ...hooks,
    pendingDialog: {
      kind: "permission",
      tool: "Read",
      at: hooks.lastEventAt ?? ("2026-09-12T00:00:00.000Z" as never),
    },
  });
  await h.coordinator.lead.open();
  expect(paste).not.toHaveBeenCalled();
  h.adapters.claude.listSessions = async () => {
    throw new Error("Provider unavailable");
  };
  expect((await h.coordinator.lead.open()).sessionId).toBe(target.sessionId);
  expect(paste).not.toHaveBeenCalled();
});
