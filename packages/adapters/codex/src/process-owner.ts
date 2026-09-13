// PID reuse is normal. A PID alone never authorizes a signal: recheck birth time and the exact
// private socket in the process command before every signal. No shared-server discovery.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export const ownerSchema = z.strictObject({
  pid: z.number().int().min(2),
  startedAt: z.string().min(1),
});
export type ProcessOwner = z.infer<typeof ownerSchema>;

export async function inspectProcess(
  pid: number,
  socket: string,
): Promise<ProcessOwner | null> {
  if (!z.number().int().min(2).safeParse(pid).success) return null;
  try {
    const { stdout } = await exec(
      "ps",
      ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
      { timeout: 5000, env: { ...process.env, LC_ALL: "C" } },
    );
    const match = z
      .string()
      .parse(stdout)
      .trim()
      .match(/^(.{24})\s+(.+)$/);
    if (!match?.[2]?.endsWith(`app-server --listen unix://${socket}`))
      return null;
    return ownerSchema.parse({ pid, startedAt: match[1] });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    )
      return null;
    throw error;
  }
}

export async function sameProcess(
  owner: ProcessOwner,
  socket: string,
): Promise<boolean> {
  return (
    (await inspectProcess(owner.pid, socket))?.startedAt === owner.startedAt
  );
}

/** Upgrade a pre-pidfile server by querying only this task's socket, then checking its command. */
export async function socketOwner(
  socket: string,
): Promise<ProcessOwner | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec("lsof", ["-t", socket], { timeout: 5000 }));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    )
      return null;
    throw error;
  }
  const pids = z
    .array(z.coerce.number().int().min(2))
    .parse(stdout.trim().split(/\s+/));
  const owners = (
    await Promise.all(
      [...new Set(pids)].map((pid) => inspectProcess(pid, socket)),
    )
  ).filter((owner) => owner !== null);
  if (owners.length === 0)
    throw new Error("Cannot verify the process holding the task socket");
  if (owners.length > 1)
    throw new Error(
      "Multiple app-servers own the task socket; refusing to guess",
    );
  return owners[0] ?? null;
}

/**
 * App-server processes whose command line names this socket and that nobody owns any more: a
 * previous coordinator killed hard leaves its child reparented to init, still holding the thread
 * store while a fresh server is spawned beside it. Found by argv, which carries the private
 * per-task socket path, so no other task's or user's process can match.
 */
export async function orphanServers(socket: string): Promise<number[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec("ps", ["-axo", "pid=,args="], { timeout: 5000 }));
  } catch {
    return [];
  }
  const needle = `app-server --listen unix://${socket}`;
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[2]?.includes(needle) && Number(match[1]) !== process.pid)
      pids.push(Number(match[1]));
  }
  return pids;
}

export async function terminateOwned(
  owner: ProcessOwner,
  socket: string,
): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await sameProcess(owner, socket))) return;
    try {
      process.kill(owner.pid, signal);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      throw error;
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!(await sameProcess(owner, socket))) return;
      await delay(50);
    }
  }
  throw new Error(
    "Task app-server did not exit; preserving its ownership record",
  );
}
