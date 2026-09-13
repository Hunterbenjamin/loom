import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { GitAdapter, GitWorktreeObservation } from "@loom/core";
import { z } from "zod";
import {
  blobOid,
  commit,
  count,
  decode,
  git,
  nulFields,
  optionalRef,
  pathSchema,
  refName,
  sha,
  textGit,
} from "./git.js";
import { parseDirty, parseHunks, parseNumstat, parseRaw } from "./metadata.js";

export type { FileChange, GitAdapter } from "@loom/core";
export { GitError } from "./git.js";

const fileName = z
  .string()
  .min(1)
  .refine((v) => v !== "." && v !== ".." && !/[\0/\\]/.test(v));
const observation = z.object({
  path: pathSchema,
  exists: z.boolean(),
  branch: z.string().nullable(),
  headSha: sha.nullable(),
  dirty: z.boolean(),
  aheadOfBase: count,
  behindBase: count,
  conflictsWithBase: z.boolean().nullable(),
  remoteHeadSha: sha.nullable(),
  dirtyPaths: z.array(z.string().min(1)),
  reachableCommits: z.array(sha),
  reviewCommits: z
    .object({ baseSha: sha, headSha: sha, commits: z.array(sha) })
    .nullable()
    .optional(),
});
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function branchAt(path: string) {
  const result = await git(
    path,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    [0, 1],
  );
  return result.code === 1
    ? null
    : refName.parse(decode(result.output).replace(/\n$/, ""));
}
async function validateBranch(path: string, branch: string) {
  refName.parse(branch);
  await git(path, ["check-ref-format", `refs/heads/${branch}`]);
}
async function rootPath(path: string) {
  const canonical = pathSchema.parse(await realpath(path));
  const root = await realpath(
    (await textGit(canonical, ["rev-parse", "--show-toplevel"])).replace(
      /\n$/,
      "",
    ),
  );
  if (root !== canonical) throw new Error("Expected a worktree root");
  return canonical;
}

/** Uses the named remote (origin by default); reads never fetch or query the network. */
export function createGitAdapter(
  options: { remote?: string } = {},
): GitAdapter {
  const remote = refName.parse(options.remote ?? "origin");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote))
    throw new Error("Expected a remote name");
  const adapter: GitAdapter = {
    async realpath(path) {
      return pathSchema.parse(await realpath(pathSchema.parse(path)));
    },
    async currentBranch(path) {
      const branch = refName.parse(
        (
          await textGit(pathSchema.parse(path), [
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ])
        ).replace(/\n$/, ""),
      );
      return branch === "HEAD" ? null : branch;
    },
    async readWorktree(
      path,
      baseBranch,
      reachableCandidates = [],
      reviewBaseSha,
    ) {
      pathSchema.parse(path);
      refName.parse(baseBranch);
      const candidates = [...new Set(z.array(sha).parse(reachableCandidates))];
      try {
        await lstat(path);
      } catch (error) {
        if (!missing(error)) throw error;
        return observation.parse({
          path,
          exists: false,
          branch: null,
          headSha: null,
          dirty: false,
          aheadOfBase: 0,
          behindBase: 0,
          conflictsWithBase: null,
          remoteHeadSha: null,
          dirtyPaths: [],
          reachableCommits: [],
        });
      }
      const canonical = await rootPath(path);
      const branch = await branchAt(canonical);
      const headSha =
        branch === null
          ? await commit(canonical, "HEAD")
          : await optionalRef(canonical, `refs/heads/${branch}`);
      const dirtyPaths = parseDirty(
        (
          await git(canonical, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
          ])
        ).output,
      );
      const remoteHeadSha =
        branch === null
          ? null
          : await optionalRef(canonical, `refs/remotes/${remote}/${branch}`);
      const result: GitWorktreeObservation = {
        path: canonical,
        exists: true,
        branch,
        headSha,
        dirty: dirtyPaths.length > 0,
        aheadOfBase: 0,
        behindBase: 0,
        conflictsWithBase: null,
        remoteHeadSha,
        dirtyPaths,
        reachableCommits: [],
      };
      if (headSha !== null) {
        if (reviewBaseSha !== undefined) {
          const reviewBase = await commit(canonical, sha.parse(reviewBaseSha));
          const ancestor = await git(
            canonical,
            ["merge-base", "--is-ancestor", reviewBase, headSha],
            [0, 1],
          );
          result.reviewCommits =
            ancestor.code === 0
              ? {
                  baseSha: reviewBase,
                  headSha,
                  commits: z
                    .array(sha)
                    .parse(
                      (
                        await textGit(canonical, [
                          "rev-list",
                          "--reverse",
                          "--topo-order",
                          `${reviewBase}..${headSha}`,
                        ])
                      )
                        .trim()
                        .split(/\s+/)
                        .filter(Boolean),
                    ),
                }
              : null;
        }
        const baseSha = await commit(canonical, baseBranch);
        const counts = z
          .tuple([count, count])
          .parse(
            (
              await textGit(canonical, [
                "rev-list",
                "--left-right",
                "--count",
                `${baseSha}...${headSha}`,
              ])
            )
              .trim()
              .split(/\s+/),
          );
        [result.behindBase, result.aheadOfBase] = counts;
        const merge = await git(
          canonical,
          ["merge-tree", "--write-tree", "--name-only", "-z", headSha, baseSha],
          [0, 1],
        );
        // Exit 1 means conflicts, not a command failure; still require a valid result tree.
        sha.parse(nulFields(merge.output)[0]);
        result.conflictsWithBase = merge.code === 1;
        for (const candidate of candidates) {
          // Missing objects are collection failures, not evidence of non-reachability.
          await commit(canonical, candidate);
          if (
            (
              await git(
                canonical,
                ["merge-base", "--is-ancestor", candidate, headSha],
                [0, 1],
              )
            ).code === 0
          )
            result.reachableCommits.push(candidate);
        }
        if (
          (await branchAt(canonical)) !== branch ||
          (await commit(canonical, "HEAD")) !== headSha
        )
          throw new Error("Worktree HEAD changed during observation; retry");
      }
      return observation.parse(result);
    },
    async createWorktree(req) {
      const repoRoot = pathSchema.parse(req.repoRoot);
      const desired = pathSchema.parse(resolve(req.path));
      await validateBranch(repoRoot, req.branch);
      const baseSha = await commit(repoRoot, req.baseBranch);
      const findExisting = async () => {
        const fields = nulFields(
          (await git(repoRoot, ["worktree", "list", "--porcelain", "-z"]))
            .output,
        );
        let current: string | undefined;
        for (const field of fields) {
          if (field.startsWith("worktree "))
            current = pathSchema.parse(field.slice(9));
          else if (field === `branch refs/heads/${req.branch}`) {
            const path = await rootPath(pathSchema.parse(current));
            if ((await branchAt(path)) !== req.branch)
              throw new Error("Worktree branch changed; retry");
            return { path, headSha: await commit(path, "HEAD"), baseSha };
          } else if (field === "") current = undefined;
        }
        return null;
      };
      const existing = await findExisting();
      if (existing) return existing;
      const branchHead = await optionalRef(
        repoRoot,
        `refs/heads/${req.branch}`,
      );
      try {
        await git(
          repoRoot,
          branchHead === null
            ? ["worktree", "add", "-b", req.branch, "--", desired, baseSha]
            : ["worktree", "add", "--", desired, req.branch],
        );
      } catch (error) {
        const raced = await findExisting();
        if (raced) return raced;
        throw error;
      }
      const created = await findExisting();
      if (!created)
        throw new Error("Created worktree missing from Git metadata");
      return created;
    },
    async push(req) {
      const path = await rootPath(req.worktreePath);
      await validateBranch(path, req.branch);
      const expected = sha.parse(req.expectedHeadSha);
      if (
        (await branchAt(path)) !== req.branch ||
        (await commit(path, `refs/heads/${req.branch}`)) !== expected
      )
        throw new Error(
          "Refusing push: local branch head differs from expectedHeadSha",
        );
      // Push the immutable checked commit, so a concurrent local commit cannot slip into the push.
      await git(path, [
        "-c",
        "push.followTags=false",
        "push",
        "--porcelain",
        "--no-force",
        "--recurse-submodules=no",
        remote,
        `${expected}:refs/heads/${req.branch}`,
      ]);
      return { remoteHeadSha: expected };
    },
    async writeTaskFiles(worktreePath, files) {
      const path = await rootPath(worktreePath);
      const parsed = z
        .array(z.object({ name: fileName, content: z.string() }))
        .parse(files);
      const taskDir = join(path, ".task");
      await mkdir(taskDir, { recursive: true });
      if (
        (await lstat(taskDir)).isSymbolicLink() ||
        (await realpath(taskDir)) !== taskDir
      )
        throw new Error("Refusing symlinked .task directory");
      const excludePath = (
        await textGit(path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "info/exclude",
        ])
      ).replace(/\n$/, "");
      pathSchema.parse(excludePath);
      await mkdir(dirname(excludePath), { recursive: true });
      const exclude = await open(
        excludePath,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const content = await exclude.readFile("utf8");
        if (!content.split(/\r?\n/).includes("/.task/"))
          await exclude.write(
            `${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}/.task/\n`,
          );
      } finally {
        await exclude.close();
      }
      for (const file of parsed) {
        const temporary = join(taskDir, `.loom-${randomUUID()}`);
        await writeFile(temporary, file.content, { flag: "wx", mode: 0o600 });
        await rename(temporary, join(taskDir, file.name));
      }
    },
    async changedFiles(req) {
      const path = pathSchema.parse(req.repoRoot);
      const from = await commit(path, sha.parse(req.fromSha));
      const to = await commit(path, sha.parse(req.toSha));
      const args = [
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--no-relative",
        from,
        to,
        "--",
      ];
      const raw = parseRaw(
        (await git(path, ["diff", "--raw", "--no-abbrev", "-z", ...args]))
          .output,
      );
      const stats = parseNumstat(
        (await git(path, ["diff", "--numstat", "-z", ...args])).output,
      );
      if (raw.length !== stats.length)
        throw new Error("Inconsistent Git diff metadata");
      let empty: string | undefined;
      for (let i = 0; i < raw.length; i++) {
        const record = raw[i];
        const stat = stats[i];
        if (!record || !stat) throw new Error("Missing Git diff record");
        const { change, oldMode, newMode } = record;
        if (
          stat.oldPath !== (change.oldPath ?? change.newPath) ||
          stat.newPath !== (change.newPath ?? change.oldPath)
        )
          throw new Error("Git diff paths changed during collection");
        change.binary = stat.binary;
        if (change.binary || oldMode === "160000" || newMode === "160000")
          continue;
        if (change.oldBlobOid === null || change.newBlobOid === null)
          empty ??= blobOid.parse(
            (await git(path, ["hash-object", "-w", "--stdin"], [0], "")).output
              .toString()
              .trim(),
          );
        // Compare blobs to avoid reading/decoding patch paths, including rename and type-change headers.
        const patch = await textGit(path, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          "--no-color",
          "--no-renames",
          "--diff-algorithm=myers",
          "--inter-hunk-context=0",
          "-U0",
          change.oldBlobOid ?? z.string().parse(empty),
          change.newBlobOid ?? z.string().parse(empty),
          "--",
        ]);
        change.hunks = parseHunks(patch);
      }
      return raw.map((record) => record.change);
    },
    async readBlob(repoRoot, oid) {
      pathSchema.parse(repoRoot);
      const output = (
        await git(repoRoot, ["cat-file", "blob", blobOid.parse(oid)])
      ).output;
      if (output.subarray(0, 8000).includes(0)) return null;
      try {
        return decode(output);
      } catch {
        return null;
      }
    },
  };
  return adapter;
}
