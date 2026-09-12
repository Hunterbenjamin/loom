import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionId } from "@loom/core";
import { FakeClock, FakePaneHost, FakeProviders } from "@loom/fake-agent";
import { openStore } from "@loom/store";
import { expect, test, vi } from "vitest";
import { fixture } from "../../../packages/core/test/fixtures.js";
import { configSchema } from "./config.js";
import { OperatorSession } from "./operator.js";
import { wireOperatorTerminal } from "./test-operator-terminal.js";

test("failed native turn pauses the durable queue until explicit open, including after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-operator-turn-"));
  const f = fixture();
  const clock = new FakeClock();
  const providers = new FakeProviders(clock, f.state.config.sha256);
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
      now: () => clock.now(),
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
  try {
    await operator.load();
    operator.failure("pass_failed", null, "pending evidence");
    await operator.recover();
    const sessionId = operator.sessionId as ProviderSessionId;
    const send = vi.spyOn(paneHost, "pasteText");
    providers.finish(sessionId, "failed");
    await operator.pump();
    expect(operator.state()).toMatchObject({ status: "error", queueLength: 1 });
    expect(operator.state().error).toContain("Operator turn failed");
    expect(await providers.claude.headlessState(sessionId)).toBeNull();
    const pane = operator.paneRef;
    if (!pane) throw new Error("Missing Operator terminal");
    expect((await paneHost.getPane(pane))?.dead).toBe(false);
    await operator.pump();
    await operator.pump();
    expect(send).not.toHaveBeenCalled();
    await operator.close();
    store.close();
    store = await openStore({
      dataRoot: root,
      instance: "test",
      config: f.state.config,
    });
    operator = create();
    await operator.load();
    const launch = vi.spyOn(paneHost, "ensurePane");
    await operator.recover();
    expect(launch).not.toHaveBeenCalled();
    expect(operator.state()).toMatchObject({
      status: "error",
      queueLength: 1,
      sessionId,
    });
    await operator.open();
    expect(launch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(operator.state()).toMatchObject({
      status: "working",
      queueLength: 1,
      error: null,
    });
  } finally {
    await operator.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
