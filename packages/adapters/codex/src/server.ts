import { type ChildProcess, execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

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

/** Owns only the child it spawns. Never discovers or kills another server. */
export class TaskServer {
  readonly home: string;
  readonly socket: string;
  private child: ChildProcess | null = null;
  private exit: Promise<void> | null = null;
  constructor(
    readonly directory: string,
    readonly executable: string,
  ) {
    if (!isAbsolute(directory))
      throw new Error("Codex task directory must be absolute");
    this.home = join(directory, "codex-home");
    this.socket = join(directory, "app-server.sock");
    if (this.socket.includes(":") || Buffer.byteLength(this.socket) > 100)
      throw new Error("Codex socket path must be short and contain no colon");
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
    try {
      await lstat(this.socket);
      throw new Error("Refusing to replace an existing app-server socket");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
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
    const child = spawn(
      this.executable,
      ["app-server", "--listen", `unix://${this.socket}`],
      {
        cwd: this.directory,
        env,
        stdio: "ignore",
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
  }
  async stop() {
    const child = this.child;
    if (!child) return;
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
    // This socket belongs to the child above; never remove one during startup/discovery.
    await unlink(this.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
