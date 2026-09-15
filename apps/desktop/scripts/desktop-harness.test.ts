import { access } from "node:fs/promises";
import { expect, test } from "vitest";
import { TrackerClient } from "../src/shared/client.js";
import { connectionFromEnvironment } from "../src/shared/connection.js";
import { startDesktopHarness } from "./desktop-harness.js";

test("script data comes from an authenticated disposable coordinator with fake agents", async () => {
  const harness = await startDesktopHarness({ count: 5 });
  let client: TrackerClient | undefined;
  try {
    expect(harness.h.store.tasks()).toHaveLength(5);
    expect(
      harness.h.store.loadTaskState(harness.approvalTaskId).task.stage,
    ).toBe("plan_approval");
    expect(harness.host).toBeUndefined();
    const config = connectionFromEnvironment(harness.env);
    if (config.mode !== "live") throw new Error("Missing harness connection");
    const connected = new Promise<void>((resolve) => {
      client = new TrackerClient({
        ...config,
        clientId: "desktop-harness-test",
        onState: (state) => {
          if (state.collections.task.size === 5) resolve();
        },
        onStatus() {},
      });
      client.start();
    });
    await connected;
    expect(
      await client?.command({
        kind: "human",
        taskId: harness.approvalTaskId,
        command: { type: "approve_plan", planVersion: 1 },
      }),
    ).toMatchObject({ ok: true, result: { kind: "human" } });
    await harness.h.coordinator.settle();
    expect(
      harness.h.store.loadTaskState(harness.approvalTaskId).task.stage,
    ).toBe("in_progress");
  } finally {
    client?.stop();
    await harness.close();
  }
  await expect(access(harness.h.dataRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("terminal scripts resolve coordinator-owned shells on their private host", async () => {
  const harness = await startDesktopHarness({ count: 2, terminals: true });
  try {
    const { openTaskTerminal } = await import(
      "../../coordinator/src/task-terminal.js"
    );
    const { resolveAttach } = await import("../src/main/attach.js");
    const terminal = await openTaskTerminal(
      harness.h.store.loadTaskState(harness.terminalTaskId),
      harness.h.repo,
      harness.h.adapters,
    );
    expect(terminal.source).toBe("project");
    const target = await resolveAttach(
      connectionFromEnvironment(harness.env),
      terminal.target,
    );
    expect(target.attach?.argv).toContain(`loom-${harness.env.LOOM_INSTANCE}`);
    expect(target.pane?.dead).toBe(false);
    expect((await harness.host?.listPanes())?.length).toBeGreaterThan(0);
  } finally {
    await harness.close();
  }
});
