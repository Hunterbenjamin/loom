import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BlobOid, Sha, WorktreePath } from "@loom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitAdapter } from "./index.js";

const exec = promisify(execFile);
let directory: string;
let repo: WorktreePath;
const adapter = createGitAdapter();
async function command(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return (
    await exec("git", args, {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "",
        GIT_COMMITTER_EMAIL: "",
      },
    })
  ).stdout.trim();
}
async function git(...args: string[]) {
  return command(repo, ...args);
}
async function save(name: string, content: string | Buffer) {
  await writeFile(join(repo, name), content);
}
async function commitAll(message = "fixture") {
  await git("add", "-A");
  await git("-c", "user.useConfigOnly=false", "commit", "-m", message);
  return (await git("rev-parse", "HEAD")) as Sha;
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "loom-git-test-")));
  repo = join(directory, "repo") as WorktreePath;
  await mkdir(repo);
  await git("init", "--initial-branch=main", "--object-format=sha1");
  await save("tracked.txt", "one\ntwo\nthree\n");
  await save(".gitignore", "build/\n");
  await commitAll();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("worktree observations", () => {
  it("reads branches from nested pane start directories and preserves detached HEAD semantics", async () => {
    const nested = join(repo, "nested") as WorktreePath;
    await mkdir(nested);
    expect(await adapter.currentBranch(nested)).toBe("main");
    await git("checkout", "-b", "feat/pane");
    expect(await adapter.currentBranch(nested)).toBe("feat/pane");
    await git("checkout", "--detach");
    expect(await adapter.currentBranch(nested)).toBeNull();
    await expect(
      adapter.currentBranch(directory as WorktreePath),
    ).rejects.toThrow();
    await expect(
      adapter.currentBranch(join(directory, "missing") as WorktreePath),
    ).rejects.toThrow();
  });
  it("canonicalizes symlinks and macOS /var aliases", async () => {
    const alias = join(directory, "alias");
    await symlink(repo, alias);
    expect(await adapter.realpath(alias)).toBe(repo);
    if (repo.startsWith("/private/var/"))
      expect(await adapter.realpath(repo.replace(/^\/private/, ""))).toBe(repo);
  });
  it("reports complete staged, unstaged, renamed and untracked paths, excluding task/build files", async () => {
    await save("tracked.txt", "changed\n");
    await save('quote"雪\nnew.txt', "new\n");
    await mkdir(join(repo, "build"));
    await save("build/output", "ignored");
    await mkdir(join(repo, ".task"));
    await save(".task/brief.md", "ignored even without exclude");
    const result = await adapter.readWorktree(repo, "main");
    expect(result.dirtyPaths).toEqual(['quote"雪\nnew.txt', "tracked.txt"]);
    expect(result.dirty).toBe(true);
    await git("mv", "tracked.txt", "renamed.txt");
    expect((await adapter.readWorktree(repo, "main")).dirtyPaths).toEqual([
      'quote"雪\nnew.txt',
      "renamed.txt",
      "tracked.txt",
    ]);
  });
  it("ignores tracked .task changes too", async () => {
    await mkdir(join(repo, ".task"));
    await save(".task/brief.md", "first");
    await commitAll();
    await save(".task/brief.md", "second");
    expect((await adapter.readWorktree(repo, "main")).dirty).toBe(false);
  });
  it("reports clean counts and only requested reachable commits", async () => {
    const base = (await git("rev-parse", "HEAD")) as Sha;
    await git("checkout", "-b", "feat/work");
    await save("new", "feature");
    const head = await commitAll();
    await git("checkout", "main");
    await save("other", "base");
    const unrelated = await commitAll();
    await git("checkout", "feat/work");
    expect(
      await adapter.readWorktree(repo, "main", [base, head, unrelated, base]),
    ).toMatchObject({
      exists: true,
      branch: "feat/work",
      headSha: head,
      dirty: false,
      dirtyPaths: [],
      aheadOfBase: 1,
      behindBase: 1,
      conflictsWithBase: false,
      remoteHeadSha: null,
      reachableCommits: [base, head],
    });
    await expect(
      adapter.readWorktree(repo, "main", ["1".repeat(40) as Sha]),
    ).rejects.toThrow();
  });
  it("detects merge-tree conflicts without changing HEAD, index or worktree", async () => {
    await git("checkout", "-b", "feat/conflict");
    await save("tracked.txt", "feature\n");
    const head = await commitAll();
    await git("checkout", "main");
    await save("tracked.txt", "base\n");
    await commitAll();
    await git("checkout", "feat/conflict");
    const index = await readFile(join(repo, ".git/index"));
    expect((await adapter.readWorktree(repo, "main")).conflictsWithBase).toBe(
      true,
    );
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(repo, ".git/index"))).toEqual(index);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("feature\n");
  });
  it("distinguishes missing, invalid, unborn and detached worktrees", async () => {
    expect(
      (
        await adapter.readWorktree(
          join(directory, "missing") as WorktreePath,
          "main",
        )
      ).exists,
    ).toBe(false);
    await expect(
      adapter.readWorktree(directory as WorktreePath, "main"),
    ).rejects.toThrow();
    await git("checkout", "--detach");
    expect((await adapter.readWorktree(repo, "main")).branch).toBeNull();
    const empty = join(directory, "empty") as WorktreePath;
    await mkdir(empty);
    await command(empty, "init", "--initial-branch=main");
    expect(await adapter.readWorktree(empty, "main")).toMatchObject({
      exists: true,
      headSha: null,
      branch: "main",
      conflictsWithBase: null,
    });
    await expect(adapter.readWorktree(repo, "missing-base")).rejects.toThrow();
  });
  it("uses last fetched remote head without contacting the remote", async () => {
    const remote = join(directory, "remote.git");
    await command(directory, "init", "--bare", remote);
    await git("remote", "add", "origin", remote);
    await git("push", "origin", "main");
    await git("fetch", "origin");
    const fetched = await git("rev-parse", "HEAD");
    await save("new", "new");
    const local = await commitAll();
    await command(remote, "fetch", repo, local);
    await command(remote, "update-ref", "refs/heads/main", local);
    expect(await command(remote, "rev-parse", "main")).toBe(local);
    await rename(remote, `${remote}-offline`);
    expect(await adapter.readWorktree(repo, "main")).toMatchObject({
      remoteHeadSha: fetched,
      reachableCommits: [fetched],
    });
  });
});

describe("worktree actions", () => {
  it("fetches the remote base without moving local main and creates from that SHA", async () => {
    const remote = join(directory, "remote.git");
    await command(directory, "init", "--bare", remote);
    await git("remote", "add", "origin", remote);
    const local = (await git("rev-parse", "main")) as Sha;
    await save("remote-only", "new");
    const advanced = await commitAll("advance remote");
    await git("push", "origin", "main");
    await git("reset", "--hard", local);

    const fetched = await adapter.fetchBase({
      repoRoot: repo,
      baseBranch: "main",
    });
    expect(fetched.baseSha).toBe(advanced);
    expect(await git("rev-parse", "refs/heads/main")).toBe(local);
    expect(await git("rev-parse", "refs/remotes/origin/main")).toBe(advanced);
    const created = await adapter.createWorktree({
      repoRoot: repo,
      path: join(directory, "fresh"),
      branch: "feat/fresh",
      baseSha: fetched.baseSha,
    });
    expect(created.headSha).toBe(advanced);
  });
  it("fails fetches instead of falling back to a local base", async () => {
    await expect(
      adapter.fetchBase({ repoRoot: repo, baseBranch: "main" }),
    ).rejects.toThrow(/Git fetch failed/);
    await expect(
      adapter.fetchBase({ repoRoot: repo, baseBranch: "--evil" }),
    ).rejects.toThrow();
  });
  it("requires dependency merges to be ancestors of a new branch base", async () => {
    const ancestor = (await git("rev-parse", "HEAD")) as Sha;
    await git("checkout", "-b", "dependency");
    await save("dependency", "merged");
    const dependency = await commitAll("dependency");
    await git("checkout", "main");
    await save("main-only", "base");
    const baseSha = await commitAll("new base");
    await adapter.createWorktree({
      repoRoot: repo,
      path: join(directory, "ancestor"),
      branch: "feat/ancestor",
      baseSha,
      requiredCommits: [ancestor],
    });
    await expect(
      adapter.createWorktree({
        repoRoot: repo,
        path: join(directory, "missing-dependency"),
        branch: "feat/missing-dependency",
        baseSha,
        requiredCommits: [dependency],
      }),
    ).rejects.toThrow(
      `Fetched base ${baseSha} does not contain dependency merge ${dependency} yet`,
    );
  });
  it("creates once, adopts the existing branch worktree and preserves its changes", async () => {
    const req = {
      repoRoot: repo,
      path: join(directory, "work tree 雪"),
      branch: "feat/work",
      baseSha: (await git("rev-parse", "main")) as Sha,
    };
    const first = await adapter.createWorktree(req);
    await writeFile(join(first.path, "untracked"), "preserve");
    expect(
      await adapter.createWorktree({
        ...req,
        path: join(directory, "different"),
      }),
    ).toEqual(first);
    expect(await readFile(join(first.path, "untracked"), "utf8")).toBe(
      "preserve",
    );
    expect((await adapter.readWorktree(first.path, "main")).branch).toBe(
      req.branch,
    );
  });
  it("checks out a preexisting branch without resetting it", async () => {
    await git("branch", "feat/existing");
    const created = await adapter.createWorktree({
      repoRoot: repo,
      path: join(directory, "existing"),
      branch: "feat/existing",
      baseSha: (await git("rev-parse", "main")) as Sha,
    });
    expect(created.headSha).toBe(await git("rev-parse", "feat/existing"));
  });
  it("refuses an occupied destination and invalid branch", async () => {
    const req = {
      repoRoot: repo,
      path: repo,
      branch: "feat/new",
      baseSha: (await git("rev-parse", "main")) as Sha,
    };
    await expect(adapter.createWorktree(req)).rejects.toThrow();
    await expect(
      adapter.createWorktree({ ...req, branch: "--evil" }),
    ).rejects.toThrow();
  });
  it("pushes a rebased issue branch with a lease and rejects a stale remote", async () => {
    const remote = join(directory, "remote.git");
    await command(directory, "init", "--bare", remote);
    await git("remote", "add", "origin", remote);
    const old = (await git("rev-parse", "HEAD")) as Sha;
    await git("checkout", "-b", "feat/issue");
    await save("new", "new");
    const head = await commitAll();
    await expect(
      adapter.push({
        worktreePath: repo,
        branch: "feat/issue",
        expectedHeadSha: old,
        expectedRemoteHeadSha: null,
      }),
    ).rejects.toThrow("Refusing push");
    await expect(
      adapter.push({
        worktreePath: repo,
        branch: "other",
        expectedHeadSha: head,
        expectedRemoteHeadSha: null,
      }),
    ).rejects.toThrow("Refusing push");
    expect(
      await adapter.push({
        worktreePath: repo,
        branch: "feat/issue",
        expectedHeadSha: head,
        expectedRemoteHeadSha: null,
      }),
    ).toEqual({ remoteHeadSha: head });
    expect(await command(remote, "rev-parse", "feat/issue")).toBe(head);

    await git("checkout", "main");
    await save("base-update", "base");
    await commitAll("advance main");
    await git("checkout", "feat/issue");
    await git("rebase", "main");
    const rebased = (await git("rev-parse", "HEAD")) as Sha;
    expect(
      await adapter.push({
        worktreePath: repo,
        branch: "feat/issue",
        expectedHeadSha: rebased,
        expectedRemoteHeadSha: head,
      }),
    ).toEqual({ remoteHeadSha: rebased });
    expect(await command(remote, "rev-parse", "feat/issue")).toBe(rebased);

    await save("remote-change", "remote");
    const remoteChange = await commitAll("remote change");
    await command(
      repo,
      "push",
      remote,
      `${remoteChange}:refs/heads/feat/issue`,
    );
    await git("fetch", "origin");
    await git("reset", "--hard", rebased);
    await save("diverged", "diverged");
    const diverged = await commitAll();
    await expect(
      adapter.push({
        worktreePath: repo,
        branch: "feat/issue",
        expectedHeadSha: diverged,
        expectedRemoteHeadSha: rebased,
      }),
    ).rejects.toThrow(/Git push failed.*failed to push some refs/s);
    expect(await command(remote, "rev-parse", "feat/issue")).toBe(remoteChange);
  });
  it("writes task files repeatedly and excludes them in the shared Git directory", async () => {
    const work = await adapter.createWorktree({
      repoRoot: repo,
      path: join(directory, "linked"),
      branch: "feat/linked",
      baseSha: (await git("rev-parse", "main")) as Sha,
    });
    const exclude = join(repo, ".git/info/exclude");
    await writeFile(exclude, "# preserve without newline");
    await adapter.writeTaskFiles(work.path, [
      { name: "brief.md", content: "first" },
    ]);
    await adapter.writeTaskFiles(work.path, [
      { name: "brief.md", content: "second" },
    ]);
    expect(await readFile(join(work.path, ".task/brief.md"), "utf8")).toBe(
      "second",
    );
    expect(await readFile(exclude, "utf8")).toBe(
      "# preserve without newline\n/.task/\n",
    );
    expect(await command(work.path, "status", "--porcelain")).toBe("");
  });
  it("removes only clean registered worktrees inside the allowed root and keeps branches", async () => {
    const allowedRoot = join(directory, "worktrees");
    await mkdir(allowedRoot);
    const branch = "feat/remove";
    const path = join(allowedRoot, "remove") as WorktreePath;
    const baseSha = (await git("rev-parse", "HEAD")) as Sha;
    const work = await adapter.createWorktree({
      repoRoot: repo,
      path,
      branch,
      baseSha,
    });
    await writeFile(join(work.path, "tracked.txt"), "modified\n");
    await expect(
      adapter.removeWorktree({ repoRoot: repo, path, branch, allowedRoot }),
    ).rejects.toThrow("dirty worktree");
    await command(work.path, "restore", "tracked.txt");
    await writeFile(join(work.path, "untracked"), "preserve");
    await expect(
      adapter.removeWorktree({ repoRoot: repo, path, branch, allowedRoot }),
    ).rejects.toThrow("dirty worktree");
    await rm(join(work.path, "untracked"));
    await adapter.writeTaskFiles(work.path, [
      { name: "brief.md", content: "ignored cleanup file" },
    ]);
    await expect(
      adapter.removeWorktree({ repoRoot: repo, path, branch, allowedRoot }),
    ).resolves.toEqual({ removed: true });
    expect(await git("rev-parse", `refs/heads/${branch}`)).toBe(baseSha);
    await expect(
      adapter.removeWorktree({ repoRoot: repo, path, branch, allowedRoot }),
    ).resolves.toEqual({ removed: false });
  });
  it("refuses outside and unregistered directories without touching their files", async () => {
    const allowedRoot = join(directory, "worktrees");
    const outside = join(directory, "outside") as WorktreePath;
    const unregistered = join(allowedRoot, "ordinary") as WorktreePath;
    await mkdir(allowedRoot);
    await mkdir(outside);
    await mkdir(unregistered);
    await writeFile(join(outside, "keep"), "outside");
    await writeFile(join(unregistered, "keep"), "ordinary");
    await expect(
      adapter.removeWorktree({
        repoRoot: repo,
        path: outside,
        branch: "feat/outside",
        allowedRoot,
      }),
    ).rejects.toThrow("outside");
    await expect(
      adapter.removeWorktree({
        repoRoot: repo,
        path: unregistered,
        branch: "feat/ordinary",
        allowedRoot,
      }),
    ).rejects.toThrow("not the registered worktree");
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside");
    expect(await readFile(join(unregistered, "keep"), "utf8")).toBe("ordinary");
  });
  it("refuses traversal and .task symlinks, replaces file symlinks safely", async () => {
    const target = join(directory, "outside");
    await writeFile(target, "preserve");
    await expect(
      adapter.writeTaskFiles(repo, [{ name: "../outside", content: "bad" }]),
    ).rejects.toThrow();
    await symlink(directory, join(repo, ".task"));
    await expect(
      adapter.writeTaskFiles(repo, [{ name: "outside", content: "bad" }]),
    ).rejects.toThrow();
    await rm(join(repo, ".task"));
    await mkdir(join(repo, ".task"));
    await symlink(target, join(repo, ".task/brief.md"));
    await adapter.writeTaskFiles(repo, [{ name: "brief.md", content: "new" }]);
    expect(await readFile(target, "utf8")).toBe("preserve");
  });
});

describe("diffs and blobs", () => {
  it("returns renames and unicode/quoted/newline paths from metadata with precise hunks", async () => {
    const old = 'original"雪\n.txt';
    const next = 'renamed"葉\n.txt';
    await save(old, "a\nb\nc\nd\ne\nf\n");
    const from = await commitAll();
    await git("mv", old, next);
    await save(next, "a\nb\nchanged\nd\ne\nf\n");
    await save("added 雪.txt", "new\n");
    await save("tracked.txt", "one\ntwo\nthree\nlast\n");
    const to = await commitAll();
    await git("config", "core.quotePath", "true");
    const changes = await adapter.changedFiles({
      repoRoot: repo,
      fromSha: from,
      toSha: to,
    });
    expect(changes.find((c) => c.status === "renamed")).toMatchObject({
      oldPath: old,
      newPath: next,
      binary: false,
      hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }],
    });
    expect(changes.find((c) => c.status === "added")).toMatchObject({
      oldPath: null,
      oldBlobOid: null,
      newPath: "added 雪.txt",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }],
    });
    expect(changes.find((c) => c.newPath === "tracked.txt")?.hunks).toEqual([
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 },
    ]);
    expect(
      await adapter.changedFiles({ repoRoot: repo, fromSha: to, toSha: to }),
    ).toEqual([]);
  });
  it("handles deletions, empty files, binary metadata and binary readBlob", async () => {
    const from = (await git("rev-parse", "HEAD")) as Sha;
    await rm(join(repo, "tracked.txt"));
    await save("empty", "");
    await save("binary", Buffer.from([1, 0, 2]));
    await save(".gitattributes", "attribute-binary -diff\n");
    await save("attribute-binary", "text but binary attribute\n");
    const to = await commitAll();
    const changes = await adapter.changedFiles({
      repoRoot: repo,
      fromSha: from,
      toSha: to,
    });
    expect(changes.find((c) => c.status === "deleted")).toMatchObject({
      newPath: null,
      newBlobOid: null,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 }],
    });
    expect(changes.find((c) => c.newPath === "empty")?.hunks).toEqual([]);
    expect(changes.find((c) => c.newPath === "attribute-binary")?.binary).toBe(
      true,
    );
    const binary = changes.find((c) => c.newPath === "binary");
    expect(binary).toMatchObject({ binary: true, hunks: [] });
    expect(
      await adapter.readBlob(repo, binary?.newBlobOid as BlobOid),
    ).toBeNull();
    const empty = changes.find((c) => c.newPath === "empty");
    expect(await adapter.readBlob(repo, empty?.newBlobOid as BlobOid)).toBe("");
    await expect(
      adapter.readBlob(repo, "1".repeat(40) as BlobOid),
    ).rejects.toThrow();
  });
  it("handles a regular file becoming a symlink", async () => {
    const from = (await git("rev-parse", "HEAD")) as Sha;
    await rm(join(repo, "tracked.txt"));
    await symlink(".gitignore", join(repo, "tracked.txt"));
    const to = await commitAll();
    const [change] = await adapter.changedFiles({
      repoRoot: repo,
      fromSha: from,
      toSha: to,
    });
    expect(change).toMatchObject({
      status: "type_changed",
      oldPath: "tracked.txt",
      newPath: "tracked.txt",
      binary: false,
    });
    expect(await adapter.readBlob(repo, change?.newBlobOid as BlobOid)).toBe(
      ".gitignore",
    );
  });
});

it("observes the complete reviewer range and refuses unrelated history", async () => {
  const base = (await git("rev-parse", "HEAD")) as Sha;
  await git("checkout", "-b", "feat/reviewer");
  await save("tracked.txt", "implementation\n");
  const roundHead = await commitAll("Implementation");
  await save("tracked.txt", "first fix\n");
  const first = await commitAll("Fix first finding");
  await save("test.txt", "required test\n");
  const second = await commitAll("Fix missing test");
  expect(
    (await adapter.readWorktree(repo, "main", [], roundHead)).reviewCommits,
  ).toEqual({ baseSha: roundHead, headSha: second, commits: [first, second] });
  expect(
    (await adapter.readWorktree(repo, "main", [], second)).reviewCommits
      ?.commits,
  ).toEqual([]);
  await git("checkout", "-b", "feat/unrelated", base);
  await save("tracked.txt", "different history\n");
  await commitAll("Other history");
  expect(
    (await adapter.readWorktree(repo, "main", [], roundHead)).reviewCommits,
  ).toBeNull();
});
