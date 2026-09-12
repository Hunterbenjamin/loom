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

test("a client connects, takes a snapshot and sees its repo", async () => {
  const h = await served();
  const client = await connect(h, "window-1");
  expect(client.state).toBeTruthy();
  expect([...(client.state?.collections.repo.values() ?? [])]).toHaveLength(1);
  // Sequences are positive, so the first snapshot is 1 and the first patch will be 2.
  expect(client.state?.seq).toBe(1);
  expect(client.state?.epoch).toBe(h.coordinator.epoch);
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
    description: "Replace the contents of example.txt.",
    providers: null,
    requirePlanApproval: null,
    blockedBy: [],
    budgetMinutes: null,
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
    description: "",
    providers: null,
    requirePlanApproval: null,
    blockedBy: [],
    budgetMinutes: null,
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
  ).toContain("provider_permission");
  expect(
    client.state?.collections.inbox.get(taskId)?.reasonRuns.provider_permission,
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
