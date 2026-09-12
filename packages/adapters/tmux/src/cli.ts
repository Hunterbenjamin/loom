// Every tmux invocation goes through here: an explicit socket, an argv array (never a shell),
// and an explicit client environment. tmux copies PATH from the *client* process into a new
// pane and `-e PATH=…` does not override it, so the client environment is part of the
// isolation policy, not a detail. See README, "What the real tool does".

import { execFile } from "node:child_process";
import { z } from "zod";

export class TmuxError extends Error {
  constructor(
    readonly code: string,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TmuxError";
  }
}

/** tmux says this when the socket has no server, or the target vanished. */
export const isMissing = (error: unknown): boolean =>
  error instanceof TmuxError && ["no_server", "not_found"].includes(error.code);

const stdout = z.string();

export type TmuxCli = (
  args: string[],
  options?: { env?: Record<string, string> },
) => Promise<string>;

/**
 * tmux rewrites non-printable characters in `-F` output (the unit separator the pane format
 * uses becomes `_`) unless its locale is UTF-8. The client environment is ours to construct,
 * and `update-environment ""` keeps it out of the panes, so guarantee one here.
 */
export function withUtf8Locale(
  env: Record<string, string>,
): Record<string, string> {
  const declared = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  if (/utf-?8/i.test(declared)) return env;
  return {
    ...env,
    LC_CTYPE: process.platform === "darwin" ? "UTF-8" : "C.UTF-8",
  };
}

/** Names whose absence breaks a process for reasons that have nothing to do with isolation. */
export const BASE_ENV_NAMES = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
] as const;

/** The client environment tmux itself runs in: an allowlist taken from `source`, nothing else. */
export function baseEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function classify(stderr: string): TmuxError {
  const detail = stderr.trim();
  const lower = detail.toLowerCase();
  if (lower.startsWith("no server running"))
    return new TmuxError("no_server", detail);
  if (lower.startsWith("can't find") || lower.includes("session not found"))
    return new TmuxError("not_found", detail);
  if (lower.includes("duplicate session"))
    return new TmuxError("duplicate_session", detail);
  return new TmuxError("tmux_failed", detail);
}

export function createCli(input: {
  executable: string;
  socketName: string;
  timeoutMs: number;
  env: Record<string, string>;
}): TmuxCli {
  const env = withUtf8Locale(input.env);
  return (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        input.executable,
        ["-L", input.socketName, ...args],
        {
          // No shell, a bounded buffer, and an environment we constructed, never inherited.
          env: { ...env, ...options?.env },
          timeout: input.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, out, err) => {
          if (!error) return resolve(stdout.parse(out));
          if (err) return reject(classify(err));
          reject(new TmuxError("tmux_failed", error.message));
        },
      );
    });
}
