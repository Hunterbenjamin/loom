import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { BlobOid, Sha, WorktreePath } from "@loom/core";
import { z } from "zod";

export const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .transform((v) => v as Sha);
export const blobOid = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .transform((v) => v as BlobOid);
export const pathSchema = z
  .string()
  .min(1)
  .refine((v) => isAbsolute(v) && !v.includes("\0"))
  .transform((v) => v as WorktreePath);
export const refName = z
  .string()
  .min(1)
  .refine((v) => !v.startsWith("-") && !/[\0\r\n]/.test(v));
export const count = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Errors deliberately omit command arguments and stderr (remote URLs may contain credentials).
 * `hint` is one phrase from a fixed vocabulary, recognised in stderr, so "push failed" says why.
 */
export class GitError extends Error {
  constructor(
    public readonly operation: string,
    public readonly exitCode: number | null,
    public readonly hint: string | null = null,
  ) {
    super(
      `Git ${operation} failed (exit ${exitCode ?? "unknown"})${hint ? `: ${hint}` : ""}`,
    );
    this.name = "GitError";
  }
}
const HINTS: [RegExp, string][] = [
  [
    /stale info/i,
    "the remote branch moved since Loom last saw it (lease refused)",
  ],
  [/non-fast-forward|fetch first/i, "rejected as non-fast-forward"],
  [
    /could not read from remote|could not resolve host|connection (timed out|refused)/i,
    "the remote could not be reached",
  ],
  [
    /authentication failed|permission denied|403/i,
    "the remote refused the credentials",
  ],
  [/protected branch/i, "the remote protects the branch"],
  [/timed out/i, "the command timed out"],
];
export function hintFrom(stderr: string): string | null {
  return HINTS.find(([pattern]) => pattern.test(stderr))?.[1] ?? null;
}

export async function git(
  cwd: string,
  args: string[],
  allowed = [0],
  input?: string,
) {
  // The subcommand, skipping `-c key=value` pairs: "push", not "-c".
  const operation =
    args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ??
    "command";
  return new Promise<{ output: Buffer; code: number }>((resolve, reject) => {
    // Inherited Git routing variables must not redirect commands away from this worktree.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const child = spawn(
      "git",
      ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", ...args],
      {
        cwd,
        env: {
          ...env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      child.kill();
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        overflow = true;
        child.kill();
      } else chunks.push(chunk);
    });
    const stderr: Buffer[] = [];
    let stderrSize = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrSize > 64 * 1024) return;
      stderrSize += chunk.length;
      stderr.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new GitError(operation, null));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow || code === null || !allowed.includes(code))
        reject(
          new GitError(
            operation,
            code,
            overflow
              ? "the command timed out or produced too much output"
              : // `push --porcelain` reports a rejection on stdout, the rest on stderr.
                hintFrom(
                  `${Buffer.concat(stderr).toString("utf8")}\n${Buffer.concat(chunks).toString("utf8")}`,
                ),
          ),
        );
      else resolve({ output: Buffer.concat(chunks), code });
    });
    child.stdin.end(input);
  });
}

export function decode(output: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
export async function textGit(cwd: string, args: string[]) {
  return decode((await git(cwd, args)).output);
}
export async function commit(cwd: string, ref: string): Promise<Sha> {
  refName.parse(ref);
  return sha.parse(
    (
      await textGit(cwd, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim(),
  );
}
export async function optionalRef(
  cwd: string,
  ref: string,
): Promise<Sha | null> {
  const result = await git(
    cwd,
    ["show-ref", "--verify", "--quiet", ref],
    [0, 1],
  );
  return result.code === 1 ? null : commit(cwd, ref);
}
export function nulFields(output: Buffer): string[] {
  const value = decode(output);
  if (value === "") return [];
  z.string().endsWith("\0").parse(value);
  return value.slice(0, -1).split("\0");
}
