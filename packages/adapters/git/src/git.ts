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

/** Errors deliberately omit command arguments and stderr (remote URLs may contain credentials). */
export class GitError extends Error {
  constructor(
    public readonly operation: string,
    public readonly exitCode: number | null,
  ) {
    super(`Git ${operation} failed (exit ${exitCode ?? "unknown"})`);
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
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new GitError(args[0] ?? "spawn", null));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow || code === null || !allowed.includes(code))
        reject(new GitError(args[0] ?? "command", code));
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
