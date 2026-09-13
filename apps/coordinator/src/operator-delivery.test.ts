import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionId } from "@loom/core";
import { FakeClock, FakePaneHost, FakeProviders } from "@loom/fake-agent";
import { openStore } from "@loom/store";
import { afterEach, expect, test, vi } from "vitest";
import { fixture } from "../../../packages/core/test/fixtures.js";
import { configSchema } from "./config.js";
import { sha256 } from "./derive.js";
import { OperatorSession } from "./operator.js";
import { wireOperatorTerminal } from "./test-operator-terminal.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "loom-operator-delivery-"));
  const f = fixture();
  const clock = new FakeClock();
  const providers = new FakeProviders(clock, sha256);
  const paneHost = new FakePaneHost();
  wireOperatorTerminal(paneHost, providers);
  let store = await openStore({
    dataRoot: root,
    instance: "test",
    config: f.state.config,
  });
  const config = configSchema.parse({
    instance: "test",
    dataRoot: root,
    worktreeRoot: join(root, "worktrees"),
    token: "test-token-0123456789abcdef",
    models: { claude: "fake", codex: "fake" },
  });
  const create = () =>
    new OperatorSession({
      store,
      adapters: { claude: providers.claude, paneHost },
      config,
      mcpEntry: () => ({ type: "http", url: "http://127.0.0.1:1/mcp" }),
      now: clock.now,
      observe: async () => f.observations,
      workflow: async () => ({}),
      reconcile: async () => {},
      enqueue: () => {},
      changed: async () => {},
      createBug: () => {
        throw new Error("Unexpected filing");
      },
    });
  let operator = create();
  await operator.load();
  await operator.open();
  const id = operator.sessionId as ProviderSessionId;
  const session = providers.get(id).value;
  if (session.provider !== "claude" || !session.agentsEntry)
    throw new Error("Missing Claude session");
  cleanups.push(async () => {
    await operator.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    clock,
    providers,
    paneHost,
    id,
    session,
    entry: session.agentsEntry,
    get operator() {
      return operator;
    },
    get store() {
      return store;
    },
    queue() {
      store.operator.enqueue({
        id: "main-message:test",
        kind: "main_message",
        at: clock.now(),
        taskId: null,
        runId: null,
        repoId: "repo",
        message: "hello",
        occurrence: "test",
        count: 1,
      });
    },
    async restart() {
      await operator.close();
      store.close();
      store = await openStore({
        dataRoot: root,
        instance: "test",
        config: f.state.config,
      });
      operator = create();
      await operator.load();
      await operator.recover();
    },
  };
}

for (const restart of [false, true])
  test(`unconfirmed input is confirmed by transcript on ${restart ? "startup" : "the next pump"}`, async () => {
    const h = await setup();
    const paste = vi.spyOn(h.paneHost, "pasteText");
    h.queue();
    await h.operator.pump();
    expect(paste).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "Message from Main: hello",
    );
    // The provider received and answered; neither HTTP hook survived the coordinator.
    h.providers.finish(h.id, "completed");
    h.session.hooks.promptSubmits = [];
    h.session.hooks.lastStop = null;
    const receipts = h.providers.get(h.id).transcript.splice(0);
    h.entry.status = "waiting";
    h.clock.advance(30001);
    await h.operator.pump();
    expect(h.operator.state().status).toBe("error");
    h.providers.get(h.id).transcript.push(...receipts);
    h.entry.status = "idle";
    if (restart) await h.restart();
    else await h.operator.pump();
    await h.operator.pump();
    expect(h.operator.state()).toMatchObject({ status: "idle", error: null });
    expect(h.store.operator.pendingChat()).toEqual([]);
    expect(paste).toHaveBeenCalledOnce();
  });

test("unconfirmed input retries through idle gate after restart; waiting and busy retain it", async () => {
  const h = await setup();
  const paste = vi
    .spyOn(h.paneHost, "pasteText")
    .mockResolvedValueOnce("written");
  h.queue();
  await h.operator.pump();
  h.entry.status = "waiting";
  h.clock.advance(30001);
  await h.operator.pump();
  await h.restart();
  expect(h.operator.state().status).toBe("error");
  expect(paste).toHaveBeenCalledOnce();
  h.entry.status = "busy";
  await h.operator.pump();
  expect(h.operator.state().error).toBeNull();
  expect(paste).toHaveBeenCalledOnce();
  h.entry.status = "idle";
  h.session.hooks.pendingDialog = {
    kind: "permission",
    tool: "test",
    at: h.clock.now(),
  };
  await h.operator.retry();
  expect(paste).toHaveBeenCalledOnce();
  h.session.hooks.pendingDialog = null;
  await h.operator.pump();
  await h.operator.pump();
  expect(paste).toHaveBeenCalledTimes(2);
  expect(h.operator.state()).toMatchObject({ status: "working", error: null });
  expect(h.store.operator.pendingChat()).toEqual([]);
});

test("Retry can recheck and send unconfirmed input before timeout without replacing the session", async () => {
  const h = await setup();
  const paste = vi
    .spyOn(h.paneHost, "pasteText")
    .mockRejectedValueOnce(new Error("Transport failed"));
  h.queue();
  await expect(h.operator.pump()).rejects.toThrow("Transport failed");
  expect(h.operator.state().error).toContain("Transport failed");
  await h.operator.retry();
  expect(paste).toHaveBeenCalledTimes(2);
  expect(h.operator.state()).toMatchObject({ sessionId: h.id, error: null });
});

test("a genuine failed native turn stays visible and Retry reuses its session", async () => {
  const h = await setup();
  const paste = vi.spyOn(h.paneHost, "pasteText");
  h.queue();
  await h.operator.pump();
  h.providers.finish(h.id, "failed");
  await h.operator.pump();
  await h.restart();
  await h.operator.pump();
  expect(h.operator.state().error).toContain("Operator turn failed");
  expect(paste).toHaveBeenCalledOnce();
  h.clock.advance(1);
  await h.operator.retry();
  expect(paste).toHaveBeenCalledTimes(2);
  expect(h.operator.state()).toMatchObject({ sessionId: h.id, error: null });
});

test("Main chat remains queued even if tools complete its event before an idle prompt", async () => {
  const h = await setup();
  const paste = vi.spyOn(h.paneHost, "pasteText");
  h.entry.status = "busy";
  h.queue();
  await h.operator.pump();
  await h.operator.invoke("append_note", {
    eventId: "main-message:test",
    text: "Hello!",
  });
  h.entry.status = "waiting";
  await h.operator.pump();
  expect(paste).not.toHaveBeenCalled();
  await h.restart();
  h.entry.status = "idle";
  await h.operator.pump();
  await h.operator.pump();
  expect(paste).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    "Message from Main: hello",
  );
  await h.operator.invoke("append_note", {
    eventId: "main-message:test",
    text: "Hello again!",
  });
  expect(h.store.operator.unreadReplies("repo")).toMatchObject([
    { body: "Hello!" },
  ]);
  expect(h.store.operator.unreadReplies("repo")).toHaveLength(1);
  h.providers.finish(h.id, "completed");
  await h.operator.pump();
  await h.restart();
  expect(h.store.operator.pendingChat()).toEqual([]);
  expect(h.store.operator.pending()).toEqual([]);
  expect(paste).toHaveBeenCalledOnce();
});
