import type { ClientState, Command } from "@loom/protocol";
import { afterEach, expect, test } from "vitest";
import { snapshot } from "../../../../packages/protocol/src/test-support.js";
import { ProtocolServer } from "../../../coordinator/src/server.js";
import type { Row } from "../../../coordinator/src/views.js";
import { TrackerClient } from "./client.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const body = snapshot();
  const task = body.tasks[0];
  if (!task) throw new Error("missing fixture");
  let rows: Row[] = [{ collection: "task", key: task.id, value: task }];
  const commands: Command[] = [];
  const deps = {
    token: "test-token-0123456789",
    instance: "dev",
    version: "0.0.0",
    startedAt: task.createdAt,
    epoch: "first",
    heartbeatMs: 50,
    bind: { host: "127.0.0.1", port: 0 },
    now: () => task.updatedAt,
    snapshot: async () => rows,
    task: (taskId: string) =>
      (rows.find((row) => row.collection === "task" && row.key === taskId)
        ?.value as typeof task | undefined) ?? null,
    ensure: async () => {},
    onError: (error: Error) => {
      throw error;
    },
    command: async (value: unknown) => {
      commands.push(value as Command);
      return {
        ok: false as const,
        error: {
          code: "guard_failed" as const,
          message: "Reviewed SHA changed",
          details: ["Refresh the review"],
        },
      };
    },
  };
  let server = new ProtocolServer(deps);
  await server.start();
  cleanups.push(() => server.stop());
  const states: ClientState[] = [];
  const statuses: string[] = [];
  const client = new TrackerClient({
    url: server.url as string,
    token: deps.token,
    instance: "dev",
    clientId: "test-window",
    retryMs: 10,
    onState: (state) => states.push(state),
    onStatus: (status) => statuses.push(status),
  });
  cleanups.push(() => client.stop());
  client.start();
  await expect.poll(() => states.length).toBe(1);
  return {
    client,
    states,
    statuses,
    task,
    commands,
    server: () => server,
    replace: (next: Row[]) => {
      rows = next;
    },
    async restart() {
      const url = new URL(server.url as string);
      await server.stop();
      server = new ProtocolServer({
        ...deps,
        epoch: "second",
        bind: { host: url.hostname, port: Number(url.port) },
      });
      await server.start();
    },
  };
}

test("authenticates, subscribes, applies patches, recovers a gap and reconnects to a fresh snapshot", async () => {
  const h = await setup();
  expect(h.states[0]?.collections.task.get(h.task.id)?.title).toBe(
    h.task.title,
  );
  const changed = { ...h.task, title: "Live title" };
  h.replace([{ collection: "task", key: changed.id, value: changed }]);
  h.server().publish([{ op: "upsert", collection: "task", value: changed }]);
  await expect
    .poll(() => h.states.at(-1)?.collections.task.get(changed.id)?.title)
    .toBe("Live title");
  h.server().skipSequence("test-window");
  const fresh = { ...changed, title: "Recovered" };
  h.replace([{ collection: "task", key: fresh.id, value: fresh }]);
  h.server().publish([{ op: "upsert", collection: "task", value: fresh }]);
  await expect
    .poll(() => h.states.at(-1)?.collections.task.get(fresh.id)?.title)
    .toBe("Recovered");
  await h.restart();
  await expect.poll(() => h.states.at(-1)?.epoch).toBe("second");
  expect(h.statuses).toContain("disconnected");
  expect(h.states.at(-1)?.collections.task.size).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 220));
  expect(h.server().clients).toBe(1); // heartbeat replies kept it alive
});

test("reports the coordinator rejection, sends exactly once, and refuses writes while disconnected", async () => {
  const h = await setup();
  const command: Command = {
    kind: "human",
    taskId: h.task.id,
    command: { type: "retry" },
  };
  expect(await h.client.command(command)).toMatchObject({
    ok: false,
    error: { code: "guard_failed", message: "Reviewed SHA changed" },
  });
  expect(h.commands).toEqual([command]);
  h.client.stop();
  expect(await h.client.command(command)).toMatchObject({
    ok: false,
    error: { code: "unavailable" },
  });
  expect(h.commands).toHaveLength(1);
});

test("refreshes task subscriptions and drops details on selection changes", async () => {
  const h = await setup();
  const body = snapshot();
  const run = body.runs[0];
  const finding = body.findings[0];
  if (!run || !finding) throw new Error("missing fixture");
  h.replace([
    { collection: "task", key: h.task.id, value: h.task },
    { collection: "run", key: run.id, value: run },
    { collection: "finding", key: finding.id, value: finding },
  ]);
  h.client.setDetail([{ kind: "task", taskId: finding.taskId }]);
  await expect.poll(() => h.states.at(-1)?.collections.finding.size).toBe(1);
  h.client.setDetail([]);
  await expect.poll(() => h.states.at(-1)?.collections.finding.size).toBe(0);
  // The list asked for runs, so a listed task's run stays without a detail subscription.
  expect(h.states.at(-1)?.collections.run.size).toBe(1);
});
