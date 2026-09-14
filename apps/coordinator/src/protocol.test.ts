// The protocol server (brief §8). A fake client connects, gets a snapshot, sends a command,
// receives the ack and the resulting patches, and detects a forced sequence gap.

import type { TaskId } from "@loom/core";
import { loadScenarios } from "@loom/fake-agent";
import { PROTOCOL_VERSION } from "@loom/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { LoomClient } from "./client.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";

let open: Harness[] = [];
const clients: LoomClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  const all = open;
  open = [];
  for (const value of all) await value.close().catch(() => undefined);
});

const connect = async (h: Harness, id: string, subscriptions = []) => {
  const client = await LoomClient.connect({
    url: h.coordinator.protocol.url as string,
    token: h.config.token,
    clientId: id,
    kind: "cli",
    subscriptions,
  });
  clients.push(client);
  return client;
};

const served = async () => {
  const h = await createHarness({ serveProtocol: true });
  open.push(h);
  return h;
};

test("retry reports the reconciler rejection instead of a successful queue acknowledgement", async () => {
  const h = await served();
  const task = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "No retryable run",
    description: "",
  });
  const client = await connect(h, "retry-refusal");
  expect(
    await client.command({
      kind: "human",
      taskId: task.task.id,
      command: { type: "retry" },
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "invalid_input",
      message: "retry is not allowed in backlog",
    },
  });
}, 30_000);

test("a client connects, takes a snapshot and sees its repo", async () => {
  const h = await served();
  const client = await connect(h, "window-1");
  expect(client.state).toBeTruthy();
  expect([...(client.state?.collections.repo.values() ?? [])]).toHaveLength(1);
  // Sequences are positive, so the first snapshot is 1 and the first patch will be 2.
  expect(client.state?.seq).toBe(1);
  expect(client.state?.epoch).toBe(h.coordinator.epoch);
}, 30_000);

test("settings updates publish atomically, reject stale/global-only writes, and capture repository defaults", async () => {
  const h = await served();
  const first = await connect(h, "settings-first");
  const second = await connect(h, "settings-second");
  const scope = { kind: "repository" as const, repoId: h.repo.id };
  const before = first.state?.collections.settings.get(`repo:${h.repo.id}`);
  expect(before?.effective.roles.implementer.provider).toBe(
    h.repo.defaultProviders.implementer,
  );
  const saved = await first.command({
    kind: "update_settings",
    scope,
    expectedVersion: before?.version ?? 0,
    patch: {
      roles: { planner: { model: "claude-opus-4-6" } },
      workflow: { size: "small", requirePlanApproval: true },
      repository: { baseBranch: "develop", serialTests: true },
    },
  });
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
  expect(saved).toMatchObject({
    ok: true,
    result: { kind: "settings_updated", version: 1 },
  });
  await vi.waitFor(() =>
    expect(
      second.state?.collections.settings.get(`repo:${h.repo.id}`)?.version,
    ).toBe(1),
  );
  const effective = second.state?.collections.settings.get(
    `repo:${h.repo.id}`,
  )?.effective;
  expect(effective).toMatchObject({
    roles: {
      planner: { model: "claude-opus-4-6" },
      implementer: { provider: h.repo.defaultProviders.implementer },
      reviewer: { provider: h.repo.defaultProviders.reviewer },
    },
    workflow: { size: "small", requirePlanApproval: true },
    repository: { baseBranch: "develop", serialTests: true },
  });
  expect(
    await second.command({
      kind: "update_settings",
      scope,
      expectedVersion: 0,
      patch: { workflow: { size: "normal" } },
    }),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("another window") },
  });
  expect(
    await second.command({
      kind: "update_settings",
      scope,
      expectedVersion: 1,
      patch: { runtime: { capTotal: 8 } },
    }),
  ).toMatchObject({
    ok: false,
    error: { message: "Setting is not editable in this scope" },
  });
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Uses repository settings",
    description: "",
  }).task;
  expect(created).toMatchObject({
    size: "small",
    requirePlanApproval: true,
    roleProfiles: {
      implementer: { provider: h.repo.defaultProviders.implementer },
      reviewer: { provider: h.repo.defaultProviders.reviewer },
    },
  });
  expect(h.store.repos()[0]).toMatchObject({
    baseBranch: "develop",
    serialTests: true,
  });
  expect(
    await first.command({
      kind: "reset_settings",
      scope,
      expectedVersion: 1,
      keys: ["workflow.size", "repository.baseBranch"],
    }),
  ).toMatchObject({
    ok: true,
    result: { kind: "settings_updated", version: 2 },
  });
  await vi.waitFor(() =>
    expect(
      second.state?.collections.settings.get(`repo:${h.repo.id}`)?.effective,
    ).toMatchObject({
      workflow: { size: "normal" },
      repository: { baseBranch: "main" },
    }),
  );
  expect(
    second.state?.collections.settings.get(`repo:${h.repo.id}`)?.audit,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ settingKey: "workflow.size" }),
      expect.objectContaining({ settingKey: "repository.baseBranch" }),
    ]),
  );
}, 30_000);

test("immediate global settings update core consumers and reset to the startup baseline", async () => {
  const h = await served();
  const setExcludedAuthors = vi.fn();
  h.adapters.github.setExcludedAuthors = setExcludedAuthors;
  const client = await connect(h, "runtime-settings");
  const task = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Runtime configuration",
    description: "",
  }).task;
  const before = client.state?.collections.settings.get("global");
  expect(
    await client.command({
      kind: "update_settings",
      scope: { kind: "global" },
      expectedVersion: before?.version ?? 0,
      patch: {
        runtime: {
          capTotal: 9,
          deliveryTimeoutMs: 2222,
          githubPollMs: 3333,
          resyncMs: 4444,
          excludedAuthors: ["loom-bot"],
        },
      },
    }),
  ).toMatchObject({ ok: true });
  expect(h.coordinator.config).toMatchObject({
    caps: { total: 9 },
    deliveryTimeoutMs: 2222,
    githubPollMs: 3333,
    resyncMs: 4444,
    excludedAuthors: ["loom-bot"],
  });
  expect(h.store.loadTaskState(task.id).config).toMatchObject({
    deliveryTimeoutMs: 2222,
    githubPollMs: 3333,
  });
  expect(setExcludedAuthors).toHaveBeenLastCalledWith(["loom-bot"]);

  expect(
    await client.command({
      kind: "reset_settings",
      scope: { kind: "global" },
      expectedVersion: 1,
      keys: [
        "runtime.capTotal",
        "runtime.deliveryTimeoutMs",
        "runtime.githubPollMs",
        "runtime.resyncMs",
        "runtime.excludedAuthors",
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(h.coordinator.config).toMatchObject({
    caps: { total: 4 },
    deliveryTimeoutMs: 10_000,
    githubPollMs: 60_000,
    resyncMs: 60_000,
    excludedAuthors: [],
  });
  expect(h.store.loadTaskState(task.id).config).toMatchObject({
    deliveryTimeoutMs: 10_000,
    githubPollMs: 60_000,
  });
  expect(setExcludedAuthors).toHaveBeenLastCalledWith([]);
}, 30_000);

test("human terminal close confirms native removal and publishes deletion to connected clients", async () => {
  const h = await served();
  const ref = {
    hostGeneration: `loom-${h.config.instance}#1`,
    sessionName: "loom-workbench",
    windowId: "@7",
    paneId: "%7",
  };
  const observation = {
    ref,
    dead: false,
    exitCode: null,
    pid: 12345,
    command: "sh",
    startCwd: h.repo.root,
    cwd: h.repo.root,
  };
  let present = true;
  vi.spyOn(h.paneHost, "listPanes").mockImplementation(async () =>
    present ? [observation] : [],
  );
  vi.spyOn(h.paneHost, "listClients").mockResolvedValue([]);
  vi.spyOn(h.paneHost, "getPane").mockImplementation(async () =>
    present ? observation : null,
  );
  const close = vi
    .spyOn(h.paneHost, "closeTerminal")
    .mockImplementation(async () => {
      present = false;
    });
  const client = await LoomClient.connect({
    url: h.coordinator.protocol.url as string,
    token: h.config.token,
    clientId: "terminal-close",
    kind: "cli",
    subscriptions: [{ kind: "panes" }],
  });
  clients.push(client);
  expect(
    await client.command({ kind: "close_terminal", target: ref }),
  ).toMatchObject({
    ok: true,
    result: { kind: "terminal_closed", target: ref },
  });
  expect(close).toHaveBeenCalledExactlyOnceWith(ref);
  expect([...(client.state?.collections.pane.values() ?? [])]).toEqual([]);
  expect(
    await client.command({ kind: "close_terminal", target: ref }),
  ).toMatchObject({ ok: true });
  close.mockClear();
  expect(
    await client.command({
      kind: "close_terminal",
      target: { ...ref, hostGeneration: "loom-other#1" },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await client.command({
      kind: "close_terminal",
      target: { ...ref, sessionName: "loom-main" },
    }),
  ).toMatchObject({ ok: false });
  expect(close).not.toHaveBeenCalled();
}, 30_000);

test("a bad token is refused and the socket closes", async () => {
  const h = await served();
  await expect(
    LoomClient.connect({
      url: h.coordinator.protocol.url as string,
      token: "wrong-token-0123456789abcdef",
      clientId: "window-bad",
      kind: "cli",
    }),
  ).rejects.toThrow();
  expect(h.coordinator.protocol.clients).toBe(0);
}, 30_000);

test("a command is acknowledged, recorded as an input, and shows up as patches", async () => {
  const h = await served();
  const client = await connect(h, "window-2");

  const created = await client.command({
    kind: "create_task",
    repoId: h.repo.id,
    title: "Change the example",
    name: null,
    description: "Replace the contents of example.txt.",
    summary: null,
    providers: null,
    requirePlanApproval: null,
    blockedBy: [],
    budgetMinutes: null,
    size: null,
  });
  expect(created).toMatchObject({ ok: true, result: { kind: "task_created" } });
  const taskId = (created as { result: { taskId: TaskId } }).result.taskId;

  // The patch arrives because the loop committed, not because the command "did" anything.
  const patched = client.await((frame) => frame.type === "patch");
  await h.coordinator.settle();
  await patched;
  expect(client.state?.collections.task.get(taskId)?.stage).toBe("backlog");

  const moved = await client.command({
    kind: "human",
    taskId,
    command: { type: "move", to: "todo" },
  });
  expect(moved).toMatchObject({ ok: true, result: { kind: "human" } });
  const inputId = (moved as { result: { inputId: string } }).result.inputId;
  // Principle 3: the command is an input; reconcile decides what it means.
  expect(h.store.inputDisposition(taskId, inputId)).toBeNull();

  const next = client.await((frame) => frame.type === "patch");
  await h.coordinator.settle();
  await next;
  expect(h.store.inputDisposition(taskId, inputId)).toMatchObject({
    accepted: true,
  });
  expect(client.state?.collections.task.get(taskId)?.stage).not.toBe("backlog");
}, 30_000);

test("a forced sequence gap is detected and only a fresh snapshot recovers", async () => {
  const h = await served();
  const client = await connect(h, "window-3");
  const created = await client.command({
    kind: "create_task",
    repoId: h.repo.id,
    title: "First",
    name: null,
    description: "",
    summary: null,
    providers: null,
    requirePlanApproval: null,
    blockedBy: [],
    budgetMinutes: null,
    size: null,
  });
  const taskId = (created as { result: { taskId: TaskId } }).result.taskId;
  const first = client.await((frame) => frame.type === "patch");
  await h.coordinator.settle();
  await first;
  const applied = client.state?.seq ?? 0;
  expect(applied).toBeGreaterThan(0);

  // Drop a frame: the next patch's `seq` is no longer the one the client expects.
  h.coordinator.protocol.skipSequence("window-3", 1);
  const resynced = client.await((frame) => frame.type === "snapshot");
  h.coordinator.submitHuman(taskId, { type: "move", to: "todo" });
  await h.coordinator.settle();
  await resynced;

  expect(client.gaps).toHaveLength(1);
  expect(client.gaps[0]?.expected).toBe(applied + 1);
  // The snapshot names the sequence the stream continues from, and the client is whole again.
  expect(client.state?.collections.task.get(taskId)).toBeTruthy();
  expect(client.state?.seq).toBeGreaterThanOrEqual(applied + 1);
}, 30_000);

test("a client sees only what it subscribed to", async () => {
  const h = await served();
  const watcher = await connect(h, "window-4", [
    { kind: "views", views: ["needs_you"], repoIds: null },
  ] as never);
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Not yet interesting",
    description: "",
  });
  await h.coordinator.settle();
  // A backlog task with no attention is in no subscribed view.
  expect(watcher.state?.collections.task.get(created.task.id)).toBeUndefined();

  await watcher.subscribe([{ kind: "task", taskId: created.task.id }]);
  expect(watcher.state?.collections.task.get(created.task.id)).toBeTruthy();
}, 30_000);

test("the handshake refuses an unsupported protocol version", async () => {
  expect(PROTOCOL_VERSION).toBe(2);
  const h = await served();
  const socket = new WebSocket(h.coordinator.protocol.url as string);
  await new Promise<void>((resolve) =>
    socket.addEventListener("open", () => resolve()),
  );
  const frame = await new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 99,
        token: h.config.token,
        client: { id: "old", kind: "cli", name: "loom", version: "0.0.0" },
        subscriptions: [],
      }),
    );
  });
  expect(JSON.parse(frame)).toMatchObject({
    type: "error",
    error: { code: "unsupported_protocol_version" },
  });
  socket.close();
}, 30_000);

test("list clients receive plan version and core-derived inbox metadata without task subscriptions", async () => {
  const h = await served();
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Inbox metadata",
    description: "",
  });
  await h.coordinator.settle();
  const client = await connect(h, "inbox-window");
  expect(client.state?.collections.inbox.get(created.task.id)).toEqual({
    taskId: created.task.id,
    forHuman: null,
    linkedPrNumbers: [],
    reasonRuns: {},
    reviewedHead: null,
    planVersion: null,
  });
  expect(client.state?.collections.run.size).toBe(0);
});

test("inbox carries the reviewed SHA and plan version from the completed fake review", async () => {
  const h = await served();
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Review metadata",
    description: "Change the example",
  });
  h.coordinator.submitHuman(created.task.id, { type: "move", to: "todo" });
  const driver = new ScenarioDriver(
    h,
    await loadScenarios(
      new URL("./fixtures/walking-skeleton.json", import.meta.url),
    ),
  );
  await driver.run();
  await h.coordinator.settle();
  const state = h.store.loadTaskState(created.task.id);
  expect(state.task.stage).toBe("awaiting_approval");
  expect(state.review?.lastReviewedHead).toBeTruthy();
  const client = await connect(h, "review-inbox-window");
  expect(client.state?.collections.inbox.get(created.task.id)).toMatchObject({
    reviewedHead: state.review?.lastReviewedHead,
    planVersion: state.plan?.version,
  });
}, 30_000);

test("permission attribution and the selected run's attach target reach the window without recipe credentials", async () => {
  const h = await served();
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Permission metadata",
    description: "Change the example",
    providers: { planner: "claude", implementer: "claude", reviewer: "claude" },
  });
  const taskId = created.task.id;
  h.coordinator.submitHuman(taskId, { type: "move", to: "todo" });
  const driver = new ScenarioDriver(
    h,
    await loadScenarios(new URL("./fixtures/permission.json", import.meta.url)),
  );
  await driver.run({
    until: () =>
      h.store
        .loadTaskState(taskId)
        .runs.some((r) => r.role === "implementer" && r.status === "working"),
    maxSteps: 300,
  });
  const run = h.store
    .loadTaskState(taskId)
    .runs.find((r) => r.role === "implementer");
  if (!run?.sessionId) throw new Error("missing implementer");
  h.providers.request(run.sessionId, "approval", "Approve a test tool");
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();
  const client = await connect(h, "permission-inbox-window");
  expect(
    client.state?.collections.task.get(taskId)?.attention.reasons,
  ).toContain("provider_input");
  expect(
    client.state?.collections.inbox.get(taskId)?.reasonRuns.provider_input,
  ).toMatchObject([
    {
      id: run.id,
      role: "implementer",
      provider: "claude",
      mode: "interactive",
    },
  ]);
  const result = await client.command({
    kind: "open_attach_session",
    runId: run.id,
  });
  expect(result).toMatchObject({
    ok: true,
    result: {
      kind: "attach_session",
      target: {
        runId: run.id,
        attach: { kind: "pane_host", env: {} },
        pane: { paneId: run.pane?.paneId },
      },
    },
  });
  if (result.ok && result.result.kind === "attach_session")
    expect(result.result.target.attach?.env).toEqual({});
}, 30_000);

test("an adopted external run with unknown model reaches snapshots and patches", async () => {
  const h = await served();
  const created = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "External run",
    description: "",
  });
  const taskId = created.task.id;
  h.coordinator.submitHuman(taskId, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const worktree = h.store.loadTaskState(taskId).worktree;
  if (!worktree) throw new Error("missing worktree");
  const client = await connect(h, "external-patches", [
    { kind: "task", taskId },
  ] as never);
  const sessionId = h.providers.create(
    "claude",
    worktree.path,
    undefined,
    "interactive",
  );
  h.coordinator.loop.enqueue(taskId);
  await h.coordinator.settle();
  await vi.waitFor(() => {
    expect([...(client.state?.collections.run.values() ?? [])]).toContainEqual(
      expect.objectContaining({ sessionId, origin: "external", model: "" }),
    );
  });
  const snapshotClient = await connect(h, "external-snapshot", [
    { kind: "task", taskId },
  ] as never);
  expect([
    ...(snapshotClient.state?.collections.run.values() ?? []),
  ]).toContainEqual(
    expect.objectContaining({ sessionId, origin: "external", model: "" }),
  );
  expect(h.logs.filter((line) => line.includes("Could not publish"))).toEqual(
    [],
  );
}, 30_000);

test("publish errors deduplicate by task and cause, and reset after success", async () => {
  const h = await served();
  await connect(h, "publish-errors");
  const taskId = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Publish errors",
    description: "",
  }).task.id;
  const otherId = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Other task",
    description: "",
  }).task.id;
  await h.coordinator.settle();
  let cause: string | null = "first failure";
  const original = h.coordinator.protocol.publish.bind(h.coordinator.protocol);
  const publish = vi.spyOn(h.coordinator.protocol, "publish");
  publish.mockImplementation((changes) => {
    if (cause !== null) throw new Error(cause);
    return original(changes);
  });
  const errors = () =>
    h.logs.filter((line) => line.startsWith("Could not publish"));
  const tick = async (id: TaskId) => {
    const calls = publish.mock.calls.length;
    h.coordinator.loop.enqueue(id);
    await h.coordinator.settle();
    await vi.waitFor(() =>
      expect(publish.mock.calls.length).toBeGreaterThan(calls),
    );
    // Flush the publish promise's rejection handler without depending on a wall-clock sleep.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await tick(taskId);
    await tick(taskId);
    expect(errors()).toHaveLength(1);
    await tick(otherId);
    expect(errors()).toHaveLength(2);
    cause = "second failure";
    await tick(taskId);
    expect(errors()).toHaveLength(3);
    cause = null;
    await tick(taskId);
    cause = "first failure";
    await tick(taskId);
    expect(errors()).toHaveLength(4);
  } finally {
    publish.mockRestore();
  }
}, 30_000);

test("select_repo and add_repo publish one durable selection to existing and new windows", async () => {
  const { mkdir, realpath } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const h = await served();
  const first = await connect(h, "project-first");
  const observer = await connect(h, "project-observer");
  expect(first.state?.collections.project.get("project")?.repoId).toBe(
    h.repo.id,
  );
  const root = join(h.dataRoot, "second-repository");
  await mkdir(root);
  const add = { kind: "add_repo" as const, root, github: "sample/second" };
  expect(await first.command(add)).toMatchObject({
    ok: true,
    result: { kind: "repo_added", repoId: "sample-second" },
  });
  await vi.waitFor(() =>
    expect(observer.state?.collections.project.get("project")?.repoId).toBe(
      "sample-second",
    ),
  );
  expect(observer.state?.collections.repo.get("sample-second")).toMatchObject({
    root: await realpath(root),
    github: "sample/second",
    baseBranch: h.config.baseBranch,
    serialTests: false,
  });
  expect(await first.command(add)).toMatchObject({ ok: true });
  expect(h.store.repos()).toHaveLength(2);
  expect(h.paneHost.launches).toHaveLength(0);
  expect(
    await first.command({
      kind: "select_repo",
      repoId: "missing" as typeof h.repo.id,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await first.command({ ...add, root: `${root}/missing` }),
  ).toMatchObject({ ok: false });
  expect(h.store.selectedRepo()).toBe("sample-second");
  expect(
    (await connect(h, "project-new")).state?.collections.project.get("project")
      ?.repoId,
  ).toBe("sample-second");
  expect(
    await first.command({ kind: "select_repo", repoId: h.repo.id }),
  ).toMatchObject({
    ok: true,
    result: { kind: "repo_selected", repoId: h.repo.id },
  });
  await vi.waitFor(() =>
    expect(observer.state?.collections.project.get("project")?.repoId).toBe(
      h.repo.id,
    ),
  );
  first.close();
  observer.close();
  const restarted = await h.restart();
  open.push(restarted);
  expect(
    (
      await connect(restarted, "project-restart")
    ).state?.collections.project.get("project")?.repoId,
  ).toBe(h.repo.id);
});

test("rename commands map to the pane host and publish authoritative names to every window", async () => {
  const h = await served();
  const ref = {
    hostGeneration: `loom-${h.config.instance}#1`,
    sessionName: "research",
    windowId: "@7",
    paneId: "%7",
  };
  let observation = {
    ref,
    sessionId: "$7",
    windowName: "shell",
    dead: false,
    exitCode: null,
    pid: 12345,
    command: "sh",
    startCwd: h.repo.root,
    cwd: h.repo.root,
  };
  vi.spyOn(h.paneHost, "listPanes").mockImplementation(async () => [
    observation,
  ]);
  vi.spyOn(h.paneHost, "listClients").mockResolvedValue([]);
  const renameSession = vi
    .spyOn(h.paneHost, "renameSession")
    .mockImplementation(async (request) => {
      observation = {
        ...observation,
        ref: { ...observation.ref, sessionName: request.name },
      };
    });
  const renameWindow = vi
    .spyOn(h.paneHost, "renameWindow")
    .mockImplementation(async (request) => {
      observation = { ...observation, windowName: request.name };
    });
  const client = await connect(h, "rename-first", [{ kind: "panes" }] as never);
  const other = await connect(h, "rename-second", [{ kind: "panes" }] as never);
  const space = {
    kind: "rename_space" as const,
    hostGeneration: ref.hostGeneration,
    sessionId: "$7",
    name: "New space",
  };
  expect(await client.command(space)).toMatchObject({
    ok: true,
    result: { kind: "renamed" },
  });
  expect(renameSession).toHaveBeenCalledExactlyOnceWith({
    hostGeneration: ref.hostGeneration,
    sessionId: "$7",
    name: "New space",
  });
  const tab = {
    kind: "rename_tab" as const,
    hostGeneration: ref.hostGeneration,
    windowId: ref.windowId,
    name: "New tab",
  };
  expect(await client.command(tab)).toMatchObject({ ok: true });
  expect(renameWindow).toHaveBeenCalledExactlyOnceWith({
    hostGeneration: ref.hostGeneration,
    windowId: ref.windowId,
    name: "New tab",
  });
  await vi.waitFor(() => {
    for (const window of [client, other])
      expect([
        ...(window.state?.collections.pane.values() ?? []),
      ]).toMatchObject([
        { sessionName: "New space", windowName: "New tab", paneId: ref.paneId },
      ]);
  });
  renameSession.mockRejectedValueOnce(new Error("duplicate session"));
  expect(await client.command({ ...space, name: "Taken" })).toMatchObject({
    ok: false,
    error: { message: "duplicate session" },
  });
  expect(
    await client.command({ ...space, hostGeneration: "loom-other#1" }),
  ).toMatchObject({ ok: false });
  expect(renameSession).toHaveBeenCalledTimes(2);
  expect(
    [...(client.state?.collections.pane.values() ?? [])][0]?.sessionName,
  ).toBe("New space");
}, 30_000);

test("Workbench creation passes selected space and split identity through scratch and publishes native metadata", async () => {
  const h = await served();
  const ref = {
    hostGeneration: `loom-${h.config.instance}#1`,
    sessionName: "Selected space",
    windowId: "@7",
    paneId: "%7",
  };
  const original = {
    ref,
    sessionId: "$7",
    windowName: "shell",
    windowIndex: 2,
    windowLayout: "abcd,120x40,0,0,7",
    dead: false,
    exitCode: null,
    pid: 12345,
    command: "sh",
    startCwd: h.repo.root,
    cwd: h.repo.root,
  };
  const created = {
    ...original,
    ref: { ...ref, paneId: "%8" },
    windowLayout: "abcd,120x40,0,0[120x20,0,0,7,120x19,0,21,8]",
  };
  let inventory = [original];
  vi.spyOn(h.paneHost, "listPanes").mockImplementation(async () => inventory);
  vi.spyOn(h.paneHost, "listClients").mockResolvedValue([]);
  vi.spyOn(h.paneHost, "getPane").mockImplementation(
    async (target) =>
      inventory.find(
        (p) =>
          p.ref.paneId === target.paneId &&
          p.ref.hostGeneration === target.hostGeneration,
      ) ?? null,
  );
  const scratch = vi
    .spyOn(h.paneHost, "createScratch")
    .mockImplementation(async () => {
      inventory = [original, created];
      return created.ref;
    });
  vi.spyOn(h.paneHost, "attachArgs").mockReturnValue([
    "tmux",
    "-L",
    "loom-test",
    "attach-session",
  ]);
  const client = await connect(h, "space-create", [{ kind: "panes" }] as never);
  expect(
    await client.command({
      kind: "open_workbench_terminal",
      key: crypto.randomUUID(),
      target: ref,
      split: "below",
      label: "Shell",
    }),
  ).toMatchObject({
    ok: true,
    result: { kind: "attach_session", target: { target: created.ref } },
  });
  expect(scratch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ target: ref, split: "below", cwd: h.repo.root }),
  );
  await vi.waitFor(() =>
    expect([...(client.state?.collections.pane.values() ?? [])]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paneId: "%8",
          windowIndex: 2,
          windowLayout: created.windowLayout,
        }),
      ]),
    ),
  );
  for (const target of [
    { ...ref, hostGeneration: "loom-other#1" },
    { ...ref, paneId: "%404" },
    { ...ref, windowId: "@404" },
  ]) {
    expect(
      await client.command({
        kind: "open_workbench_terminal",
        key: crypto.randomUUID(),
        target,
        label: "Shell",
      }),
    ).toMatchObject({ ok: false });
  }
  expect(scratch).toHaveBeenCalledTimes(1);
});
