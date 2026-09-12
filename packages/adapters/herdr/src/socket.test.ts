import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createHerdrAdapter } from "./index.js";
import { agentList, ok } from "./schemas.js";
import { HerdrSocket } from "./socket.js";
import { fakeServer, fixture, type Handler } from "./test-server.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function setup(handler: Handler) {
  const server = await fakeServer(handler);
  cleanups.push(() => server.close());
  const errors = vi.fn();
  const options = {
    socketPath: server.path,
    requestTimeoutMs: 100,
    reconnectMs: 10,
    onError: errors,
  };
  const socket = new HerdrSocket(options);
  const adapter = createHerdrAdapter({
    ...options,
    sessionName: "loom-test-herdr",
  });
  return { ...server, socket, adapter, errors };
}

it("decodes fragmented UTF-8 JSON and checks correlation IDs", async () => {
  const { socket } = await setup((req, conn) => {
    const response = Buffer.from(
      `${JSON.stringify({
        id: req.id,
        result: {
          type: "agent_list",
          agents: [
            { pane_id: "w1:p1", agent_status: "idle", cwd: "/tmp/広い" },
          ],
        },
      })}\n`,
    );
    const split = response.indexOf(Buffer.from("広")) + 1;
    conn.write(response.subarray(0, split));
    setTimeout(() => conn.write(response.subarray(split)), 5);
  });
  expect(
    (await socket.request("agent.list", {}, agentList)).agents[0]?.cwd,
  ).toBe("/tmp/広い");
});

it.each(["wrong-id", "bad-json", "bad-schema", "both-envelopes"])(
  "rejects %s without exposing payload text",
  async (mode) => {
    const { socket } = await setup((req, conn) => {
      if (mode === "wrong-id")
        conn.write(
          `${JSON.stringify({ id: "wrong", result: { type: "ok" } })}\n`,
        );
      if (mode === "bad-json") conn.write("secret is not json\n");
      if (mode === "bad-schema") return { result: { type: "secret" } };
      if (mode === "both-envelopes")
        conn.write(
          `${JSON.stringify({
            id: req.id,
            result: { type: "ok" },
            error: { code: "secret", message: "private" },
          })}\n`,
        );
    });
    await expect(
      socket.request("pane.report_agent_session", {}, ok),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "Herdr: invalid_response",
    });
  },
);

it.each(["disconnect", "timeout"])(
  "does not replay an uncertain mutation after %s",
  async (mode) => {
    const { socket, requests } = await setup((_req, conn) => {
      if (mode === "disconnect") conn.destroy();
    });
    await expect(socket.request("agent.prompt", {}, ok)).rejects.toMatchObject({
      code: mode === "disconnect" ? "disconnected" : "transport_timeout",
    });
    expect(requests).toHaveLength(1);
  },
);

it("replays the recorded subscription and coalesced events as hints, then unsubscribes", async () => {
  const { adapter, requests } = await setup(async (req, conn) => {
    conn.write(
      JSON.stringify({
        ...((await fixture("subscribe", "/tmp")) as object),
        id: req.id,
      }) +
        "\n" +
        JSON.stringify(await fixture("event", "/tmp")) +
        "\n" +
        JSON.stringify(await fixture("event", "/tmp")) +
        "\n",
    );
  });
  const hints = vi.fn();
  const unsubscribe = adapter.subscribe(hints);
  cleanups.push(unsubscribe);
  await vi.waitFor(() => expect(hints).toHaveBeenCalledTimes(3));
  expect(
    hints.mock.calls.every(
      ([hint]) =>
        JSON.stringify(hint) ===
        JSON.stringify({
          source: "herdr",
          worktreePath: null,
          sessionId: null,
        }),
    ),
  ).toBe(true);
  expect(requests[0]?.method).toBe("events.subscribe");
  unsubscribe();
  await delay(30);
  expect(requests).toHaveLength(1);
});

it("reconnects and requests a fresh read after losing the event stream", async () => {
  let subscriptions = 0;
  const { adapter, requests } = await setup(async (req, conn) => {
    conn.write(
      `${JSON.stringify({
        ...((await fixture("subscribe", "/tmp")) as object),
        id: req.id,
      })}\n`,
    );
    subscriptions++;
    if (subscriptions === 1) setTimeout(() => conn.destroy(), 5);
  });
  const hints = vi.fn();
  const unsubscribe = adapter.subscribe(hints);
  cleanups.push(unsubscribe);
  await vi.waitFor(() => expect(requests.length).toBe(2));
  expect(hints).toHaveBeenCalledTimes(3); // initial acknowledgement, disconnect, new acknowledgement
});

it("reports malformed events, closes the stream, and never forwards their payload", async () => {
  const { adapter, errors } = await setup(async (req, conn) => {
    conn.write(
      `${JSON.stringify({
        ...((await fixture("subscribe", "/tmp")) as object),
        id: req.id,
      })}\n{"event":"workspace_created","data":{"type":7}}\n`,
    );
  });
  const hints = vi.fn();
  const unsubscribe = adapter.subscribe(hints);
  cleanups.push(unsubscribe);
  await vi.waitFor(() => expect(errors).toHaveBeenCalled());
  unsubscribe();
  expect(errors.mock.calls[0]?.[0]).toMatchObject({ code: "invalid_event" });
  expect(hints.mock.calls.every(([hint]) => hint.worktreePath === null)).toBe(
    true,
  );
});
