import { createServer } from "node:net";
import { expect, test } from "vitest";
import { assertDevPortsAvailable, rendererServer } from "./dev-ports.js";

test("renderer keeps its configured port and rejects invalid ports", () => {
  expect(rendererServer({})).toEqual({
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  });
  expect(rendererServer({ LOOM_RENDERER_PORT: "5174" }).port).toBe(5174);
  for (const value of ["0", "65536", "invalid", ""]) {
    expect(() => rendererServer({ LOOM_RENDERER_PORT: value })).toThrow(
      "LOOM_RENDERER_PORT",
    );
  }
});

test.each(["LOOM_RENDERER_PORT", "LOOM_DEBUG_PORT"])(
  "occupied %s fails by name",
  async (name) => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    try {
      await expect(
        assertDevPortsAvailable({ [name]: String(address.port) }),
      ).rejects.toThrow(name);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
