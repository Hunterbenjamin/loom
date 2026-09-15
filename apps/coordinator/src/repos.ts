import { realpath, stat } from "node:fs/promises";
import type {
  Repo,
  RepoId,
  SettingsPatch,
  WorktreePath,
} from "@loom/core";
import type { Store } from "@loom/store";

/** Shared by the offline CLI registration and the live protocol command. */
export async function registerRepo(
  store: Store,
  root: string,
  github: string,
  baseBranch: string | undefined,
  effectiveBaseBranch: string,
  changedAt: string,
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
  };
  store.putRepo(repo);
  if (baseBranch !== undefined && baseBranch !== effectiveBaseBranch) {
    const data: SettingsPatch = { repository: { baseBranch } };
    store.settings.update({
      scope: { kind: "repository", repoId: id },
      expectedVersion: 0,
      data,
      actor: "registration",
      changedAt,
      changes: [
        {
          key: "repository.baseBranch",
          oldValue: undefined,
          newValue: baseBranch,
        },
      ],
    });
  }
  return repo;
}
