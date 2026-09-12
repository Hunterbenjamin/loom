import { expect, test } from "vitest";
import { connectionFromEnvironment } from "./connection.js";

test("requires explicit instance, data root and token; fixtures need no connection", () => {
  expect(connectionFromEnvironment({}, false).mode).toBe("unconfigured");
  expect(connectionFromEnvironment({}, true)).toEqual({ mode: "fixtures" });
  const env = {
    LOOM_INSTANCE: "dev",
    LOOM_DATA_ROOT: "/tmp/loom-test",
    LOOM_TOKEN: "test-token-0123456789",
    LOOM_BIND: "[::1]:47801",
    SECRET: "not exposed",
  };
  const config = connectionFromEnvironment(env, false);
  expect(config).toEqual({
    mode: "live",
    instance: "dev",
    dataRoot: "/tmp/loom-test",
    token: env.LOOM_TOKEN,
    url: "ws://[::1]:47801",
  });
  expect(
    connectionFromEnvironment(
      { ...env, LOOM_BIND: "user:pass@example.com:80" },
      false,
    ).mode,
  ).toBe("unconfigured");
});
