import { realpath, stat } from "node:fs/promises";
import type { Repo, RepoId, WorktreePath } from "@loom/core";
import type { Store } from "@loom/store";

/** Shared by the offline CLI registration and the live protocol command. */
export async function registerRepo(
  store: Store,
  root: string,
  github: string,
  baseBranch: string,
): Promise<Repo> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github))
    throw new Error("Expected owner/name");
  const path = await realpath(root);
  if (!(await stat(path)).isDirectory())
    throw new Error("Repository root must be a directory");
  const id = github.replace("/", "-") as RepoId;
  const existing = store
    .repos()
    .find((repo) => repo.id === id || repo.root === path);
  if (existing) {
    if (existing.root !== path || existing.github !== github)
      throw new Error(
        "Repository is already registered with a different root or origin",
      );
    return existing;
  }
  const repo: Repo = {
    id,
    root: path as WorktreePath,
    github,
    baseBranch,
    defaultProviders: {
      planner: "claude",
      implementer: "claude",
      reviewer: "codex",
    },
    serialTests: false,
  };
  store.putRepo(repo);
  return repo;
}
