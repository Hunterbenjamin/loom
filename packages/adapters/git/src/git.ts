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

const MAX_ERROR_OUTPUT = 8 * 1024;

function operation(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") {
      i++;
      continue;
    }
    if (!args[i]?.startsWith("-")) return args[i] ?? "command";
  }
  return "command";
}

function safeErrorOutput(stderr: Buffer): string | null {
  const output = stderr
    .subarray(Math.max(0, stderr.length - MAX_ERROR_OUTPUT))
    .toString("utf8")
    // Git may repeat a credential-bearing HTTP remote in an error. Keep the useful
    // host/path while removing userinfo before this reaches task state or logs.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .trim();
  return output || null;
}

export class GitError extends Error {
  constructor(
    public readonly operation: string,
    public readonly exitCode: number | null,
    public readonly stderr: string | null = null,
  ) {
    super(
      `Git ${operation} failed (exit ${exitCode ?? "unknown"})${stderr ? `: ${stderr}` : ""}`,
    );
    this.name = "GitError";
  }
}

export async function git(
  cwd: string,
  args: string[],
  allowed = [0],
  input?: string,
) {
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
    const errorChunks: Buffer[] = [];
    let errorSize = 0;
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
    child.stderr.on("data", (chunk: Buffer) => {
      errorChunks.push(chunk);
      errorSize += chunk.length;
      while (errorSize > MAX_ERROR_OUTPUT) {
        const first = errorChunks[0];
        if (!first) break;
        const excess = errorSize - MAX_ERROR_OUTPUT;
        if (first.length <= excess) {
          errorChunks.shift();
          errorSize -= first.length;
        } else {
          errorChunks[0] = first.subarray(excess);
          errorSize -= excess;
        }
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new GitError(operation(args), null));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow || code === null || !allowed.includes(code))
        reject(
          new GitError(
            operation(args),
            code,
            safeErrorOutput(Buffer.concat(errorChunks)),
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
