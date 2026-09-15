import { expect, test } from "vitest";
import { connectionConfig, connectionFromEnvironment } from "./connection.js";

test("requires explicit instance, data root and token", () => {
  expect(connectionFromEnvironment({}).mode).toBe("unconfigured");
  const env = {
    LOOM_INSTANCE: "dev",
    LOOM_DATA_ROOT: "/tmp/loom-test",
    LOOM_TOKEN: "test-token-0123456789",
    LOOM_BIND: "[::1]:47801",
    SECRET: "not exposed",
  };
  const config = connectionFromEnvironment(env);
  expect(config).toEqual({
    mode: "live",
    instance: "dev",
    dataRoot: "/tmp/loom-test",
    token: env.LOOM_TOKEN,
    url: "ws://[::1]:47801",
  });
  expect(
    connectionFromEnvironment({ ...env, LOOM_BIND: "user:pass@example.com:80" })
      .mode,
  ).toBe("unconfigured");
});

test("rejects the removed fixture connection mode", () => {
  expect(connectionConfig.safeParse({ mode: "fixtures" }).success).toBe(false);
});
