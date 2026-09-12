import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderSessionId, WorktreePath } from "@loom/core";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createHerdrAdapter, scrubEnvironment } from "./index.js";
import { ok } from "./schemas.js";
import { HerdrSocket } from "./socket.js";

// This test owns the server it starts. It refuses an existing named session, even a stale socket.
it.skipIf(process.env.LOOM_REAL_PROVIDERS !== "1")(
  "private Herdr session and Claude Haiku startup",
  async () => {
    const sessionName = "loom-test-herdr";
    const sessionDirectory = join(
      homedir(),
      ".config/herdr/sessions",
      sessionName,
    );
    const socketPath = join(sessionDirectory, "herdr.sock");
    let exists = false;
    try {
      await access(sessionDirectory);
      exists = true;
    } catch {
      /* new private session */
    }
    if (exists)
      throw new Error(
        "loom-test-herdr already exists; choose a clean test environment. It was not touched.",
      );
    const directory = await mkdtemp(join(tmpdir(), "loom-herdr-real-"));
    const config = join(directory, "config.toml");
    await writeFile(
      config,
      '[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n[session]\nresume_agents_on_restore = false\n[update]\nversion_check = false\nmanifest_check = false\n',
    );
    const server = spawn("herdr", ["--session", sessionName, "server"], {
      env: { ...scrubEnvironment(process.env), HERDR_CONFIG_PATH: config },
      stdio: "ignore",
    });
    let spawnError: Error | undefined;
    server.on("error", (error) => {
      spawnError = error;
    });
    const socket = new HerdrSocket({
      socketPath,
      requestTimeoutMs: 2000,
      reconnectMs: 100,
    });
    let connected = false;
    let unsubscribe = () => {};
    try {
      const deadline = Date.now() + 10000;
      while (!connected && Date.now() < deadline) {
        if (spawnError) throw new Error("Could not start private Herdr server");
        if (server.exitCode !== null)
          throw new Error("Private Herdr server exited before startup");
        try {
          await socket.request(
            "ping",
            {},
            z.object({ type: z.literal("pong"), protocol: z.literal(22) }),
          );
          connected = true;
        } catch {
          await delay(100);
        }
      }
      expect(connected).toBe(true);
      const adapter = createHerdrAdapter({
        socketPath,
        sessionName,
        startupTimeoutMs: 15000,
      });
      const hints = vi.fn();
      unsubscribe = adapter.subscribe(hints);
      await vi.waitFor(() => expect(hints).toHaveBeenCalled(), {
        timeout: 3000,
      });
      const cwd = (await realpath(directory)) as WorktreePath;
      const workspace = await adapter.openWorkspace({
        cwd,
        label: "Herdr adapter test",
      });
      expect(
        await adapter.openWorkspace({ cwd, label: "Herdr adapter test" }),
      ).toEqual(workspace);
      // ID allocated before launch; no prompt is ever sent to the real provider.
      const sessionId = randomUUID() as ProviderSessionId;
      const started = await adapter.startAgent({
        name: "test-claude",
        kind: "claude",
        paneId: workspace.rootPaneId,
        args: ["--model", "haiku", "--session-id", sessionId],
      });
      expect(["blocked", "ready"]).toContain(started.startup);
      await adapter.reportSession(workspace.rootPaneId, "claude", sessionId);
      await adapter.reportSession(workspace.rootPaneId, "claude", sessionId);
      const agent = await adapter.getAgent("test-claude");
      expect(agent).toMatchObject({
        cwd,
        paneId: workspace.rootPaneId,
        agentSessionId: sessionId,
      });
      expect(
        (await adapter.listAgents()).some((a) => a.name === "test-claude"),
      ).toBe(true);
      expect(await adapter.prompt("test-claude", "!should-never-run")).toBe(
        "refused",
      );
      if (started.startup === "blocked") expect(agent?.state).toBe("blocked");
    } finally {
      unsubscribe();
      if (connected)
        await socket.request("server.stop", {}, ok).catch(() => undefined);
      const deadline = Date.now() + 5000;
      while (
        server.exitCode === null &&
        server.signalCode === null &&
        Date.now() < deadline
      )
        await delay(50);
      if (server.exitCode === null && server.signalCode === null)
        server.kill("SIGTERM");
      // Never remove someone else's session: ownership was established before spawning this child.
      if (server.pid)
        await rm(sessionDirectory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
  40000,
);
