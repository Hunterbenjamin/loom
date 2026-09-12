import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { setup } from "./test-support.js";

test.each(["run", "lead", "operator", "stopped", "unknown"])(
  "%s identity is isolated",
  async (kind) => {
    const env = setup();
    const invoke = vi.fn(async () => ({ accepted: true }));
    const server = createMcpServer(
      {
        ...env.options,
        operatorHost: { invoke },
        resolveToken: () =>
          kind === "unknown"
            ? null
            : kind === "run"
              ? { runId: env.run.id, active: true }
              : {
                  kind: kind === "lead" ? "lead" : "operator",
                  active: kind !== "stopped",
                },
      },
      "test-token",
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "file_task",
        arguments: {
          eventId: "event",
          title: "Bug",
          summary: "Recover from the runtime failure",
          description: "Runtime failure",
          acceptanceTest: "Reproduce through a fake adapter.",
        },
      });
      expect(result.isError).toBe(kind !== "operator");
      expect(invoke).toHaveBeenCalledTimes(kind === "operator" ? 1 : 0);
      if (kind === "operator" || kind === "stopped") {
        expect((await client.listTools()).tools.map((t) => t.name)).toContain(
          "approve_merge",
        );
        expect(
          (await client.callTool({ name: "get_task_context", arguments: {} }))
            .isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name: "open_attach_session",
              arguments: { runId: "run" },
            })
          ).isError,
        ).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  },
);
