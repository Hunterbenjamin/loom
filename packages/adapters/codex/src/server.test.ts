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
