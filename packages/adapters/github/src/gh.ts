import { spawn } from "node:child_process";
import type { ActionError } from "@loom/core";
import type { z } from "zod";

/** Safe for action results: never exposes argv, response bodies, or stderr. */
export class GitHubError extends Error implements ActionError {
  constructor(
    public readonly code: ActionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type GhRunner = (args: string[], input?: string) => Promise<GhResult>;

export const runGh: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    // Keep the user's existing authentication; suppress prompts, debug dumps and pagers.
    const env = { ...process.env };
    delete env.GH_DEBUG;
    const child = spawn("gh", args, {
      env: { ...env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 60_000);
    for (const [stream, isOutput] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 16 * 1024 * 1024) return stop();
        if (isOutput) stdout += chunk;
        else stderr += chunk;
      });
    }
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new GitHubError("fatal", "GitHub CLI could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped || code === null)
        reject(new GitHubError("retryable", "GitHub CLI did not complete"));
      else resolve({ stdout, stderr, exitCode: code });
    });
    child.stdin.end(input);
  });

export function failure(
  result: GhResult,
  status?: number,
  headers: Record<string, string> = {},
): GitHubError {
  // CLI diagnostics are used only for error classification, never as observation state.
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (
    status === 429 ||
    headers["x-ratelimit-remaining"] === "0" ||
    headers["retry-after"] !== undefined ||
    /rate.?limit|abuse detection/i.test(diagnostic)
  )
    return new GitHubError("retryable", "GitHub rate limit reached");
  if (
    status === 405 ||
    status === 409 ||
    status === 412 ||
    /head.*(?:changed|modified|mismatch|does not match)|(?:expected|match).*head|not mergeable|not cleanly mergeable|cannot be merged|can not be merged|base branch policy prohibits|pull request is closed/i.test(
      diagnostic,
    )
  )
    return new GitHubError("precondition", "GitHub merge precondition failed");
  if (
    (status !== undefined && status >= 500) ||
    /could not resolve|error connecting|connection|timeout|timed out|TLS handshake|unexpected EOF/i.test(
      diagnostic,
    )
  )
    return new GitHubError("retryable", "GitHub temporarily unavailable");
  return new GitHubError("fatal", "GitHub request failed");
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new GitHubError("fatal", "Invalid GitHub response");
  return result.data;
}

export function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError("fatal", "Invalid GitHub JSON");
  }
}

export function response(result: GhResult) {
  const match =
    /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(
      result.stdout,
    );
  if (!match) {
    if (result.exitCode !== 0) throw failure(result);
    throw new GitHubError("fatal", "Invalid GitHub HTTP response");
  }
  const status = Number(match[1]);
  const headers: Record<string, string> = {};
  for (const line of (match[2] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new GitHubError("fatal", "Invalid GitHub headers");
    headers[line.slice(0, separator).toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  if (status !== 304 && (status !== 200 || result.exitCode !== 0))
    throw failure(result, status, headers);
  return { status, headers, body: match[3] ?? "" };
}
