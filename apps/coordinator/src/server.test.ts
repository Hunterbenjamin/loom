import { expect, test } from "vitest";
import { ProtocolServer, type ProtocolServerDeps } from "./server.js";

test("a protocol port clash rejects with LOOM_BIND without changing endpoints", async () => {
  const deps: ProtocolServerDeps = {
    token: "private-test-token",
    instance: "test",
    version: "0",
    startedAt: "now",
    epoch: "test",
    heartbeatMs: 60_000,
    bind: { host: "127.0.0.1", port: 0 },
    now: () => "now",
    snapshot: () => [],
    command: async () => ({ ok: true, result: null }),
    ensure: async () => {},
    onError: () => {},
  };
  const first = new ProtocolServer(deps);
  await first.start();
  const second = new ProtocolServer({
    ...deps,
    bind: {
      host: "127.0.0.1",
      port: Number(new URL(first.url as string).port),
    },
  });
  try {
    await expect(second.start()).rejects.toThrow(/in use; set LOOM_BIND/);
    expect(second.url).toBeNull();
    expect(first.url).not.toBeNull();
  } finally {
    await second.stop();
    await first.stop();
  }
});
