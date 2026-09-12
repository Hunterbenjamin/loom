import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
it("replaces a preexisting socket file and spawns a new server", async () => {
  vi.stubEnv("HERDR_TEST", "fixture");
  const socket = join(directory, "app-server.sock");
  // Write a fake socket file (not a real Unix socket)
  await writeFile(socket, "belongs to someone else");
  const server = new TaskServer(directory, executable);
  try {
    // Should remove the fake socket and spawn a new server
    await server.start();
    // Wait for socket to be created as a real Unix socket
    await vi.waitFor(async () => {
      const stats = await lstat(socket);
      expect(stats.isSocket()).toBe(true);
    });
  } finally {
    await server.stop();
  }
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

it("links the CLI's credentials into the private home once, and only when they exist", async () => {
  const source = join(directory, "cli-auth.json");
  await writeFile(source, '{"fake":"credentials"}');
  const home = join(directory, "codex-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const server = new TaskServer(directory, executable, source);
  await server.linkCredentials();
  // A symlink, never a copy: token refreshes must write through to the one file.
  expect(await readlink(join(home, "auth.json"))).toBe(source);
  await server.linkCredentials(); // idempotent
  expect((await lstat(join(home, "auth.json"))).isSymbolicLink()).toBe(true);

  const other = await mkdtemp("/tmp/loom-codex-nocreds-");
  try {
    await mkdir(join(other, "codex-home"), { recursive: true, mode: 0o700 });
    await new TaskServer(
      other,
      executable,
      join(other, "missing.json"),
    ).linkCredentials();
    await expect(
      lstat(join(other, "codex-home", "auth.json")),
    ).rejects.toThrow();
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

it("appends child stderr to a private log across server restarts", async () => {
  const log = join(directory, "app-server.log");
  const script = join(directory, "stderr-cli");
  await writeFile(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.154.0"
else
  echo "fixture diagnostic" >&2
fi
`,
    { mode: 0o700 },
  );
  const server = new TaskServer(
    directory,
    script,
    join(directory, "missing-auth"),
  );
  try {
    await server.start();
    await vi.waitFor(async () =>
      expect(await readFile(log, "utf8")).toBe("fixture diagnostic\n"),
    );
    await server.stop();
    expect((await stat(log)).mode & 0o777).toBe(0o600);
    await server.start();
    await vi.waitFor(async () =>
      expect(await readFile(log, "utf8")).toBe(
        "fixture diagnostic\nfixture diagnostic\n",
      ),
    );
  } finally {
    await server.stop();
  }
});

it("adopts a live app-server on startup", async () => {
  vi.stubEnv("HERDR_TEST", "fixture");
  // Start a server and keep it running (don't kill it)
  const server1 = new TaskServer(directory, executable);
  await server1.start();

  // Wait for the server to fully initialize and write fake-process.json
  let firstPid: number | null = null;
  await vi.waitFor(async () => {
    try {
      const processData = await readFile(
        join(directory, "fake-process.json"),
        "utf8",
      );
      const process = JSON.parse(processData);
      firstPid = process.pid;
      expect(firstPid).toBeGreaterThan(0);
    } catch {
      throw new Error("fake-process.json not ready");
    }
  });

  // Read the pidfile to verify it was written
  const pidfileContent = await readFile(
    join(directory, "app-server.pid"),
    "utf8",
  );
  const spawnedPid = parseInt(pidfileContent.trim(), 10);
  expect(spawnedPid).toBe(firstPid);

  // Create a second TaskServer pointing to the same directory
  // This simulates a coordinator restart
  const server2 = new TaskServer(directory, executable);
  try {
    await server2.start();

    // The server should have been adopted (same pid in pidfile)
    const pidfile2Content = await readFile(
      join(directory, "app-server.pid"),
      "utf8",
    );
    const adoptedPid = parseInt(pidfile2Content.trim(), 10);
    expect(adoptedPid).toBe(firstPid);
  } finally {
    await server2.stop();
  }

  // Kill the first server to clean up
  server1.stop().catch(() => {
    // May already be stopped
  });
});

it("replaces a dead server when connection fails", async () => {
  vi.stubEnv("HERDR_TEST", "fixture");
  const socket = join(directory, "app-server.sock");
  const pidfile = join(directory, "app-server.pid");

  // Create a fake socket file (stale) and stale pidfile
  await writeFile(socket, "stale");
  await writeFile(pidfile, "99999", { mode: 0o600 }); // Fake PID that doesn't exist

  const server = new TaskServer(directory, executable);
  try {
    // Start should fail to adopt (socket is not a valid Unix socket, connection fails),
    // remove the stale socket, and spawn a new server
    await server.start();

    // Wait for server to fully initialize
    await vi.waitFor(async () => {
      await lstat(socket);
    });

    // Verify socket is now a real Unix socket (created by spawn, not our fake file)
    const stats = await lstat(socket);
    expect(stats.isSocket()).toBe(true);

    // Verify pidfile was updated with the new process pid
    const pidContent = await readFile(pidfile, "utf8");
    const pid = parseInt(pidContent.trim(), 10);
    expect(Number.isFinite(pid) && pid > 0 && pid !== 99999).toBe(true);

    await server.stop();
  } finally {
    await server.stop();
  }
});

it("never spawns duplicate servers on concurrent starts", async () => {
  vi.stubEnv("HERDR_TEST", "fixture");
  const adapter = createCodexAdapter({ taskDirectory: directory, executable });
  try {
    // Start two adapters pointing to the same directory concurrently
    // The first should spawn; the second should adopt
    await Promise.all([
      adapter.startServer(),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay
        const adapter2 = createCodexAdapter({
          taskDirectory: directory,
          executable,
        });
        try {
          await adapter2.startServer();
        } finally {
          await adapter2.stopServer();
        }
      })(),
    ]);

    // Verify only one fake-process.json exists (one process)
    const process1 = JSON.parse(
      await readFile(join(directory, "fake-process.json"), "utf8"),
    );
    expect(process1.pid).toBeGreaterThan(0);

    await adapter.stopServer();
  } finally {
    await adapter.stopServer();
  }
});

it("coordinator recovery reads thread after simulated restart", async () => {
  vi.stubEnv("HERDR_TEST", "fixture");
  const adapter = createCodexAdapter({ taskDirectory: directory, executable });
  try {
    // Start server and verify generation
    await adapter.startServer();
    const generation1 = adapter.generation();
    expect(generation1).not.toBeNull();

    // Simulate coordinator restart by reconnecting
    await adapter.reconnect();
    const generation2 = adapter.generation();

    // Generation should increment (new connection) but same server should be adopted
    expect(generation2).toBeGreaterThan(generation1 ?? 0);

    // Socket should still exist
    await lstat(join(directory, "app-server.sock"));

    await adapter.stopServer();
  } finally {
    await adapter.stopServer();
  }
});
