// Test suites start private tmux servers named `loom-test-<pid>` (AGENTS.md, Safety). Their
// `afterAll` and `exit` hooks never run when a worker is terminated, so each interrupted run left
// servers and their shells alive: 228 sessions on one machine on 2026-09-16. Every run sweeps the
// servers whose owning process is gone, before and after, so a leak never outlives the next run.
// Only that name pattern is touched; `loom-<instance>` servers and the default socket are not.
import { execFile } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Where tmux keeps `-L` sockets: `$TMUX_TMPDIR` or /tmp, then `tmux-<uid>`. */
export function tmuxSocketDirectory(
  env: Record<string, string | undefined> = process.env,
  uid: number = process.getuid?.() ?? 0,
): string {
  return join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`);
}

/** `loom-test-<pid>`, with an optional suffix such as `-approval` (the real-provider suites). */
const TEST_SOCKET = /^loom-test-(\d+)(?:-[\w-]+)?$/;

/** The test servers in a socket listing whose owning process is no longer running. */
export function abandonedTestServers(
  names: readonly string[],
  alive: (pid: number) => boolean,
): string[] {
  return names.filter((name) => {
    const match = TEST_SOCKET.exec(name);
    return match !== null && !alive(Number(match[1]));
  });
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process we may not signal still exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills every abandoned test server and removes its socket. Returns the names swept. */
export async function sweepTestServers(
  options: {
    directory?: string;
    tmux?: string;
    alive?: (pid: number) => boolean;
  } = {},
): Promise<string[]> {
  const directory = options.directory ?? tmuxSocketDirectory();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return []; // No socket directory: tmux has never run for this user.
  }
  const swept = abandonedTestServers(names, options.alive ?? processAlive);
  for (const name of swept) {
    // A socket with no server behind it makes kill-server fail; the file goes either way.
    await new Promise<void>((resolve) =>
      execFile(
        options.tmux ?? "tmux",
        ["-S", join(directory, name), "kill-server"],
        { timeout: 5_000 },
        () => resolve(),
      ),
    );
    rmSync(join(directory, name), { force: true });
  }
  return swept;
}
