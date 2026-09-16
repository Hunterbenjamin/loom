import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderSessionId } from "@loom/core";
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
it("refuses a preexisting non-socket path and leaves it untouched", async () => {
  const socket = join(directory, "app-server.sock");
  await writeFile(socket, "belongs to someone else");
  const server = new TaskServer(directory, executable);
  await expect(server.start()).rejects.toThrow("non-socket");
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

const pidOf = async () =>
  JSON.parse(await readFile(join(directory, "fake-process.json"), "utf8"))
    .pid as number;
const spawns = async () =>
  (await readFile(join(directory, "fake-spawns.log"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);

it.each(["recorded", "numeric", "missing"])(
  "adopts a %s owner and terminates it on shutdown",
  async (metadata) => {
    const first = new TaskServer(directory, executable);
    const recovered = new TaskServer(directory, executable);
    try {
      await first.start();
      const pid = await pidOf();
      if (metadata === "missing") await unlink(first.pidfile);
      if (metadata === "numeric") await writeFile(first.pidfile, String(pid));
      await recovered.start();
      expect(recovered.running).toBe(true);
      expect(await spawns()).toEqual([pid]);
      expect(
        JSON.parse(await readFile(recovered.pidfile, "utf8")),
      ).toMatchObject({ pid, startedAt: expect.any(String) });
      await recovered.stop();
      await recovered.stop();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      await expect(lstat(first.socket)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(first.pidfile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await recovered.stop();
      await first.stop();
    }
  },
);

it.each(["dead", "unlinked"])(
  "reaps a %s predecessor before replacing its ownership record",
  async (kind) => {
    const first = new TaskServer(directory, executable);
    const replacement = new TaskServer(directory, executable);
    try {
      await first.start();
      const pid = await pidOf();
      if (kind === "dead") {
        process.kill(pid, "SIGKILL");
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      } else await unlink(first.socket);
      await replacement.start();
      expect(() => process.kill(pid, 0)).toThrow();
      const nextPid = await pidOf();
      expect(nextPid).not.toBe(pid);
      expect(await spawns()).toEqual([pid, nextPid]);
      // A stale handle must not unlink the newer server's socket or PID file.
      await first.stop();
      expect((await lstat(replacement.socket)).isSocket()).toBe(true);
      expect(
        JSON.parse(await readFile(replacement.pidfile, "utf8")),
      ).toMatchObject({ pid: nextPid });
    } finally {
      await replacement.stop();
      await first.stop();
    }
  },
);

it("refuses recovery while an unended run owns a recorded session", async () => {
  const diagnostics: import("@loom/core").AdapterDiagnostic[] = [];
  const first = new TaskServer(directory, executable);
  const recovered = new TaskServer(
    directory,
    executable,
    join(directory, "missing-auth"),
    (event) => diagnostics.push(event),
    async () => ["live-reviewer-thread"],
  );
  try {
    await first.start();
    const pid = await pidOf();
    const owner = await readFile(first.pidfile, "utf8");
    // Force recovery down the verified stale-owner path without changing process identity.
    await unlink(first.socket);
    await expect(recovered.start()).rejects.toThrow(
      "unended Codex run still owns a recorded session",
    );
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await readFile(first.pidfile, "utf8")).toBe(owner);
    expect(await spawns()).toEqual([pid]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "stale_process",
        resource: "codex_server",
        sessionId: "live-reviewer-thread",
        message: expect.stringContaining("Refusing to recover"),
      }),
    ]);
  } finally {
    await recovered.stop();
    await first.stop();
  }
});

it("serializes simultaneous starts from independent adapters", async () => {
  const first = createCodexAdapter({ taskDirectory: directory, executable });
  const second = createCodexAdapter({ taskDirectory: directory, executable });
  try {
    await Promise.all([first.startServer(), second.startServer()]);
    expect(await spawns()).toEqual([await pidOf()]);
    const generation = second.generation();
    await second.startServer();
    expect(second.generation()).toBe(generation);
  } finally {
    await second.stopServer();
    await first.stopServer();
  }
});

it("preserves a live socket whose server reports a different CODEX_HOME", async () => {
  vi.stubEnv("FAKE_SERVER_HOME", directory);
  const first = new TaskServer(directory, executable);
  const other = new TaskServer(directory, executable);
  try {
    await first.start();
    const pid = await pidOf();
    await expect(other.start()).rejects.toThrow("different CODEX_HOME");
    await other.stop();
    expect((await lstat(first.socket)).isSocket()).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await spawns()).toEqual([pid]);
  } finally {
    await other.stop();
    await first.stop();
  }
});

it("never signals an unrelated process named by a stale pidfile", async () => {
  await writeFile(
    join(directory, "app-server.pid"),
    JSON.stringify({ pid: process.pid, startedAt: "stale identity" }),
  );
  const server = new TaskServer(directory, executable);
  const signals = vi.spyOn(process, "kill");
  try {
    await server.start();
    await server.stop();
    expect(
      signals.mock.calls.filter(
        ([pid, signal]) => pid === process.pid && signal !== 0,
      ),
    ).toEqual([]);
  } finally {
    signals.mockRestore();
    await server.stop();
  }
});

it("rejects malformed process ownership without signaling a process group", async () => {
  await writeFile(join(directory, "app-server.pid"), "-1");
  const server = new TaskServer(directory, executable);
  await expect(server.start()).rejects.toThrow();
  await server.stop();
  expect(await readFile(server.pidfile, "utf8")).toBe("-1");
});

it("a fresh adapter resumes and reads the existing thread after coordinator recovery", async () => {
  const first = createCodexAdapter({ taskDirectory: directory, executable });
  const recovered = createCodexAdapter({
    taskDirectory: directory,
    executable,
  });
  const threadId = "existing-thread" as ProviderSessionId;
  try {
    await first.startServer();
    await first.resumeThread(threadId);
    const pid = await pidOf();
    // A new coordinator has no ChildProcess handle or subscriptions from the old adapter.
    await recovered.startServer();
    await recovered.resumeThread(threadId);
    expect(await recovered.readThread(threadId)).toMatchObject({
      threadId,
      status: "active",
      turns: [{ id: "surviving-turn", status: "inProgress" }],
    });
    expect(await spawns()).toEqual([pid]);
    await recovered.stopServer();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  } finally {
    await recovered.stopServer();
    await first.stopServer();
  }
});

it("retires the recorded research server on restart without launching a replacement", async () => {
  const owner = new TaskServer(directory, executable);
  await owner.start();
  const processInfo = JSON.parse(
    await readFile(join(directory, "fake-process.json"), "utf8"),
  );
  try {
    const restarted = new TaskServer(directory, executable);
    await restarted.stopRecorded();
    expect(() => process.kill(processInfo.pid, 0)).toThrow();
    await restarted.stopRecorded();
    expect(restarted.running).toBe(false);
  } finally {
    await owner.stop();
  }
});
