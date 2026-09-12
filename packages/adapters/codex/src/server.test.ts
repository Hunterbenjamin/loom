import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCodexAdapter } from "./index.js";
import { serverEnvironment, TaskServer } from "./server.js";

let directory: string;
const executable = fileURLToPath(
  new URL("./fixtures/fake-cli.mjs", import.meta.url),
);
beforeEach(async () => {
  directory = await mkdtemp("/tmp/loom-codex-process-");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("owns one private child, preserves it across reconnect, and stops/restarts idempotently", async () => {
  vi.stubEnv("HERDR_TEST", "fixture");
  vi.stubEnv("CLAUDE_CODE_TEST", "fixture");
  const adapter = createCodexAdapter({ taskDirectory: directory, executable });
  try {
    await Promise.all([adapter.startServer(), adapter.startServer()]);
    const first = JSON.parse(
      await readFile(join(directory, "fake-process.json"), "utf8"),
    );
    const generation = adapter.generation();
    expect(first).toMatchObject({
      home: join(directory, "codex-home"),
      inheritedHerdr: false,
      inheritedClaude: false,
    });
    await adapter.reconnect();
    expect(adapter.generation()).toBeGreaterThan(generation ?? 0);
    expect(
      JSON.parse(await readFile(join(directory, "fake-process.json"), "utf8"))
        .pid,
    ).toBe(first.pid);
    await Promise.all([adapter.stopServer(), adapter.stopServer()]);
    expect(adapter.generation()).toBeNull();
    expect(() => process.kill(first.pid, 0)).toThrow();
    await adapter.startServer();
    expect(adapter.generation()).toBeGreaterThan(generation ?? 0);
    expect(
      JSON.parse(await readFile(join(directory, "fake-process.json"), "utf8"))
        .pid,
    ).not.toBe(first.pid);
  } finally {
    await adapter.stopServer();
  }
});
it("refuses a preexisting socket path and never removes it", async () => {
  const socket = join(directory, "app-server.sock");
  await writeFile(socket, "belongs to someone else");
  const server = new TaskServer(directory, executable);
  await expect(server.start()).rejects.toThrow("existing");
  await server.stop();
  expect(await readFile(socket, "utf8")).toBe("belongs to someone else");
});
it("refuses a home symlink and scrubs inherited provider context", async () => {
  await symlink(directory, join(directory, "codex-home"));
  const server = new TaskServer(directory, executable);
  await expect(server.start()).rejects.toThrow("private");
  vi.stubEnv("CODEX_THREAD_ID", "unrelated");
  expect(serverEnvironment(directory).CODEX_THREAD_ID).toBeUndefined();
});
it("rejects incompatible CLI versions before launching an app-server", async () => {
  const server = new TaskServer(directory, process.execPath);
  await expect(server.start()).rejects.toThrow("0.154.0 required");
  expect(server.running).toBe(false);
});
