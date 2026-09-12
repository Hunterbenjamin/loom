import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { RpcConnection } from "./protocol.js";

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

/**
 * Manages a per-task Codex app-server process.
 *
 * On startup, the TaskServer first attempts to adopt (reconnect to) an existing app-server
 * if one is already running for this task directory. This enables coordinator restart:
 * the socket and pidfile live outside this instance so they survive coordinator restarts.
 * If adoption succeeds, no new process is spawned. If adoption fails (socket stale,
 * connection error, or CODEX_HOME mismatch), the socket is removed and a new server
 * is spawned.
 *
 * Stray servers from previous runs are reaped on both startup (after adoption/spawn)
 * and shutdown to prevent accumulation. Strays are identified by pidfile and by checking
 * if their process still exists.
 */
export class TaskServer {
  readonly home: string;
  readonly socket: string;
  readonly pidfile: string;
  private child: ChildProcess | null = null;
  private exit: Promise<void> | null = null;
  private adoptedPid: number | null = null;
  constructor(
    readonly directory: string,
    readonly executable: string,
    /**
     * The CLI's credentials, linked into the private home so the per-task server can call the
     * model. A symlink, as spikes 01 and 05 did, so token refreshes write through to the one
     * file. Absent source: no link, and the first turn fails with Codex's own auth error.
     */
    readonly credentialsSource: string = join(homedir(), ".codex", "auth.json"),
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
  /** Record the PID of an adopted or spawned server. */
  private async writeAdoptedPid(pid: number): Promise<void> {
    await writeFile(this.pidfile, pid.toString(), { mode: 0o600 });
  }
  /** Read the PID last recorded by writeAdoptedPid, or null if not found. */
  private async readAdoptedPid(): Promise<number | null> {
    try {
      const content = await readFile(this.pidfile, "utf8");
      const pid = parseInt(content.trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  /** Check if a process is still alive using kill(pid, 0). */
  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Attempt to adopt an existing app-server on the socket, or return null if adoption fails.
   * If adoption succeeds, this.adoptedPid is set and the method returns early without spawning.
   * If adoption fails, the socket is removed to prepare for a spawn.
   */
  private async tryAdoptServer(): Promise<boolean> {
    try {
      await lstat(this.socket);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false; // socket doesn't exist; will spawn
      throw error;
    }

    // Socket exists; try to connect and validate CODEX_HOME
    try {
      const connected = await RpcConnection.connect({
        socketPath: this.socket,
        timeoutMs: 5000,
        onMessage: () => {},
        onDisconnect: () => {},
      });
      try {
        const canonical = await realpath(this.home);
        const connectedCanonical = await realpath(connected.codexHome);
        if (canonical !== connectedCanonical) {
          throw new Error(
            "Refusing to adopt an app-server with a different CODEX_HOME",
          );
        }
        // Adoption successful; record the pid from the pidfile the server wrote
        const pid = await this.readAdoptedPid();
        if (pid !== null && this.processAlive(pid)) {
          this.adoptedPid = pid;
          process.stderr.write(
            `Adopted existing Codex app-server (pid ${pid}) on ${this.socket}\n`,
          );
          return true;
        }
        // pidfile missing or process dead; treat as adoption failure and fall through
      } finally {
        connected.connection.close();
      }
    } catch (error) {
      process.stderr.write(
        `Failed to adopt Codex app-server: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    // Adoption failed; remove the stale socket
    await unlink(this.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return false;
  }
  /**
   * Find and terminate stray app-servers for this task directory, except the adopted one.
   * Identifies strays by scanning for pidfiles and checking if processes still exist.
   */
  private async reapStrayServers(): Promise<void> {
    // For now, we reap by checking the pidfile we know about.
    // In a more sophisticated implementation, we could scan the directory for all pidfiles.
    const adoptedPid = this.adoptedPid;
    const knownPid = await this.readAdoptedPid();

    // Reap any pidfile that doesn't match the currently adopted/spawned pid
    if (
      knownPid !== null &&
      knownPid !== adoptedPid &&
      this.processAlive(knownPid)
    ) {
      try {
        process.kill(knownPid, "SIGTERM");
        // Wait up to 3 seconds for graceful shutdown
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (this.processAlive(knownPid)) {
              process.kill(knownPid, "SIGKILL");
            }
            resolve();
          }, 3000);
          // Check more frequently if process dies
          const check = setInterval(() => {
            if (!this.processAlive(knownPid)) {
              clearTimeout(timer);
              clearInterval(check);
              resolve();
            }
          }, 100);
        });
      } catch {
        // Process may have already exited; that's fine
      }
    }
  }
  get running() {
    return (
      this.child !== null &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }
  async start() {
    if (this.running) return;
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
    const adopted = await this.tryAdoptServer();
    if (adopted) {
      // Successfully adopted; clean up any stray servers and return
      await this.reapStrayServers();
      return;
    }

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
        await this.writeAdoptedPid(child.pid);
        this.adoptedPid = child.pid;
      }
      process.stderr.write(`Codex app-server stderr: ${logPath}\n`);
    } finally {
      // The child owns its inherited descriptor until exit.
      await log.close();
    }

    // Clean up any stray servers from previous runs
    await this.reapStrayServers();
  }
  async stop() {
    // Reap any stray servers before shutting down our own
    await this.reapStrayServers();

    const child = this.child;
    if (!child) {
      // No child; just clean up socket and pidfile if present
      await unlink(this.socket).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await unlink(this.pidfile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }

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
      this.adoptedPid = null;
    }
    // This socket belongs to the child above; never remove one during startup/discovery.
    await unlink(this.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // Clean up pidfile
    await unlink(this.pidfile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
