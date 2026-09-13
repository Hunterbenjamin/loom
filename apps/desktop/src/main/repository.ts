import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

/** Native Git output is data; never interpolate the chosen folder into a shell. */
export function githubFromOrigin(raw: unknown): string {
  const remote = z.string().trim().min(1).parse(raw);
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(
      remote,
    );
  if (!match)
    throw new Error(
      "The folder's origin must be a GitHub repository (owner/name)",
    );
  return `${match[1]}/${match[2]?.replace(/\.git$/, "")}`;
}
export async function repositoryFolder(root: string) {
  const run = promisify(execFile);
  const top = await run("git", ["-C", root, "rev-parse", "--show-toplevel"]);
  const path = z.string().trim().min(1).parse(top.stdout);
  const origin = await run("git", ["-C", path, "remote", "get-url", "origin"]);
  return { root: path, github: githubFromOrigin(origin.stdout) };
}
