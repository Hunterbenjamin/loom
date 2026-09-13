import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { AdapterDiagnostic } from "@loom/core";
import { z } from "zod";
import {
  inspectProcess,
  orphanServers,
  ownerSchema,
  type ProcessOwner,
  sameProcess,
  socketOwner,
  terminateOwned,
} from "./process-owner.js";
import { RpcConnection } from "./protocol.js";

// Serialize adapters targeting the same directory within this coordinator.
const operations = new Map<string, Promise<unknown>>();

export const CODEX_VERSION = "0.154.0";
export function serverEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("HERDR_") &&
        !key.startsWith("CLAUDE_CODE_") &&
        !key.startsWith("CODEX_"),
    ),
  );
  return { ...env, CODEX_HOME: codexHome };
}

/** Reconnects to a verified per-task server and owns its lifecycle across coordinator restarts. */
export class TaskServer {
  readonly home: string;
  readonly socket: string;
  readonly pidfile: string;
  private child: ChildProcess | null = null;
  private exit: Promise<void> | null = null;
  private owner: ProcessOwner | null = null;
  constructor(
    readonly directory: string,
    readonly executable: string,
    /**
     * The CLI's credentials, linked into the private home so the per-task server can call the
     * model. A symlink, as spikes 01 and 05 did, so token refreshes write through to the one
     * file. Absent source: no link, and the first turn fails with Codex's own auth error.
     */
    readonly credentialsSource: string = join(homedir(), ".codex", "auth.json"),
    readonly onDiagnostic?: (event: AdapterDiagnostic) => void,
    /** Routine recovery notes for the coordinator log; never events. */
    readonly onLog?: (message: string) => void,
  ) {
    if (!isAbsolute(directory))
      throw new Error("Codex task directory must be absolute");
    this.home = join(directory, "codex-home");
    this.socket = join(directory, "app-server.sock");
    this.pidfile = join(directory, "app-server.pid");
    if (this.socket.includes(":") || Buffer.byteLength(this.socket) > 100)
      throw new Error("Codex socket path must be short and contain no colon");
  }
  /** Links the CLI's `auth.json` into the private home once; never copies or reads it. */
  async linkCredentials(): Promise<void> {
    const target = join(this.home, "auth.json");
    try {
      await lstat(target);
      return; // already linked, or a real file the human placed there
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    try {
      await lstat(this.credentialsSource);
    } catch {
      return; // no CLI credentials on this machine; Codex will report its own auth error
    }
    await symlink(this.credentialsSource, target);
  }
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = await realpath(this.directory).catch(() =>
      resolve(this.directory),
    );
    const previous = operations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    operations.set(key, next);
    try {
      return await next;
    } finally {
      if (operations.get(key) === next) operations.delete(key);
    }
  }
  private async readOwner(): Promise<ProcessOwner | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.pidfile, "utf8"));
      // Upgrade the initial numeric pidfile only after checking the task socket command.
      if (typeof value === "number")
        return inspectProcess(
          z.number().int().min(2).parse(value),
          this.socket,
        );
      return ownerSchema.parse(value);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  private async recordOwner(owner: ProcessOwner): Promise<void> {
    const temporary = `${this.pidfile}.tmp`;
    await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
    await rename(temporary, this.pidfile);
    this.owner = owner;
  }
  private async removeFiles(): Promise<void> {
    for (const path of [this.socket, this.pidfile]) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  private async tryAdoptServer(): Promise<boolean> {
    const recorded = await this.readOwner();
    const info = await lstat(this.socket).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      },
    );
    if (info && !info.isSocket())
      throw new Error("Refusing to replace a non-socket app-server path");
    if (info) {
      let connected: Awaited<ReturnType<typeof RpcConnection.connect>> | null =
        null;
      try {
        connected = await RpcConnection.connect({
          socketPath: this.socket,
          timeoutMs: 5000,
          onMessage: () => {},
          onDisconnect: () => {},
        });
      } catch {
        /* Reap only a verified owner below; a failed connection is not ownership. */
      }
      if (connected) {
        try {
          if (
            (await realpath(connected.codexHome)) !==
            (await realpath(this.home))
          )
            throw new Error(
              "Refusing to adopt an app-server with a different CODEX_HOME",
            );
          const owner = await socketOwner(this.socket);
          if (!owner)
            throw new Error(
              "Cannot verify the live task app-server's process owner",
            );
          await this.recordOwner(owner);
          return true;
        } finally {
          connected.connection.close();
        }
      }
    }
    // Preserve and terminate the previous owner BEFORE overwriting its PID or unlinking its socket.
    const stale =
      recorded && (await sameProcess(recorded, this.socket))
        ? recorded
        : info
          ? await socketOwner(this.socket)
          : null;
    if (stale) {
      this.onDiagnostic?.({
        kind: "stale_process",
        resource: "codex_server",
        sessionId: null,
        message: "Recovering a verified stale private task app-server process",
      });
      await terminateOwned(stale, this.socket);
    }
    // Whatever the socket said, no second server for this task may keep running: two servers on
    // one thread store make every session fail with a thread-store conflict.
    for (const pid of await orphanServers(this.socket)) {
      if (pid === stale?.pid) continue;
      // Routine recovery, not a bug: log it, never raise it as an event.
      this.onLog?.(
        `Terminating an orphaned app-server (pid ${pid}) for this task`,
      );
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        continue;
      }
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await delay(50);
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await this.removeFiles();
    this.owner = null;
    return false;
  }
  get running(): boolean {
    if (this.child)
      return this.child.exitCode === null && this.child.signalCode === null;
    if (!this.owner) return false;
    // Liveness is only a hint; identity is checked again before any signal.
    try {
      process.kill(this.owner.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  start(): Promise<void> {
    return this.serialize(() => this.startOwned());
  }
  private async startOwned(): Promise<void> {
    if (this.child && this.running) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const canonical = await realpath(this.home);
    if (
      canonical !== join(await realpath(this.directory), "codex-home") ||
      canonical === resolve(homedir(), ".codex")
    ) {
      throw new Error(
        "CODEX_HOME must be a private directory, not a symlink to shared state",
      );
    }

    // Attempt to adopt an existing server before spawning a new one
    if (await this.tryAdoptServer()) return;

    await this.linkCredentials();
    const env = serverEnvironment(this.home);
    const version = await promisify(execFile)(this.executable, ["--version"], {
      env,
      timeout: 5000,
    });
    if (
      !z.literal(`codex-cli ${CODEX_VERSION}`).safeParse(version.stdout.trim())
        .success
    )
      throw new Error(
        `Codex ${CODEX_VERSION} required; regenerate bindings before upgrading`,
      );
    const logPath = join(this.directory, "app-server.log");
    const log = await open(logPath, "a", 0o600);
    try {
      const child = spawn(
        this.executable,
        ["app-server", "--listen", `unix://${this.socket}`],
        {
          cwd: this.directory,
          env,
          stdio: ["ignore", "ignore", log.fd],
          shell: false,
        },
      );
      this.child = child;
      this.exit = new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        child.once("error", () => resolveExit());
      });
      await new Promise<void>((resolveSpawn, reject) => {
        child.once("spawn", resolveSpawn);
        child.once("error", () =>
          reject(new Error("Could not start private Codex app-server")),
        );
      });
      // Write the pidfile after successful spawn
      if (child.pid !== undefined) {
        const owner = await inspectProcess(child.pid, this.socket);
        // A very short-lived failed child may already have exited.
        if (owner) await this.recordOwner(owner);
      }
      process.stderr.write(`Codex app-server stderr: ${logPath}\n`);
      // Do not let a second adapter mistake a still-starting child for a stray.
      const deadline = Date.now() + 5000;
      while (this.running) {
        const socket = await lstat(this.socket).catch(() => null);
        if (socket?.isSocket()) break;
        if (Date.now() >= deadline) {
          await this.stopOwned();
          throw new Error("Private Codex app-server did not create its socket");
        }
        await delay(25);
      }
      if (this.running && !this.owner) {
        const owner =
          child.pid === undefined
            ? null
            : await inspectProcess(child.pid, this.socket);
        if (!owner)
          throw new Error(
            "Cannot record the private app-server's process identity",
          );
        await this.recordOwner(owner);
      }
    } catch (error) {
      await this.stopOwned();
      throw error;
    } finally {
      // The child owns its inherited descriptor until exit.
      await log.close();
    }
  }
  stop(): Promise<void> {
    return this.serialize(() => this.stopOwned());
  }
  private async stopOwned(): Promise<void> {
    if (!this.owner && !this.child) return;
    if (this.child) {
      const child = this.child;
      if (this.running) child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.running) child.kill("SIGKILL");
      }, 3000);
      try {
        await this.exit;
      } finally {
        clearTimeout(timer);
        this.child = null;
        this.exit = null;
      }
    } else if (this.owner) {
      await terminateOwned(this.owner, this.socket);
    }
    const recorded = await this.readOwner();
    // An old handle must never remove the replacement server's files.
    if (
      !recorded ||
      (recorded.pid === this.owner?.pid &&
        recorded.startedAt === this.owner.startedAt)
    )
      await this.removeFiles();
    this.owner = null;
  }
}
