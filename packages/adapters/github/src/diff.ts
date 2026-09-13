// Immutable, on-demand content reads for the PR review shell. No local checkout is used.
import type { GitHubAdapter, PullRequestDetail } from "@loom/core";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { Api } from "./api.js";
import { type GhRunner, GitHubError, response } from "./gh.js";
import * as s from "./schemas.js";

const file = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.enum([
    "added",
    "removed",
    "modified",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
const changeType = {
  added: "ADDED",
  removed: "DELETED",
  modified: "MODIFIED",
  renamed: "RENAMED",
  copied: "COPIED",
  changed: "CHANGED",
  unchanged: "UNCHANGED",
} as const;
export function diffReads(
  run: GhRunner,
  readPatch: GitHubAdapter["readPullRequestPatch"],
): Pick<GitHubAdapter, "readPullRequestCommit" | "readPullRequestFile"> {
  return {
    async readPullRequestCommit(repo, number, commitSha) {
      s.repo.parse(repo);
      s.sha.parse(commitSha);
      s.id.parse(number);
      const api = new Api(run);
      const schema = z.object({
        sha: s.sha,
        parents: z.array(z.object({ sha: s.sha })),
        files: z.array(file),
      });
      let endpoint: string | null =
        `repos/${repo}/commits/${commitSha}?per_page=100`;
      const files: PullRequestDetail["files"] = [];
      let baseSha: string | undefined;
      const visited = new Set<string>();
      while (endpoint) {
        if (visited.has(endpoint) || visited.size >= 30)
          throw new GitHubError("fatal", "Commit files are truncated");
        visited.add(endpoint);
        const {
          value,
          next,
        }: { value: z.output<typeof schema>; next: string | null } =
          await api.get(endpoint, schema);
        if (value.sha !== commitSha)
          throw new GitHubError("fatal", "Commit SHA mismatch");
        baseSha = value.parents[0]?.sha;
        files.push(
          ...value.files.map((f) => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changeType: changeType[f.status],
          })),
        );
        endpoint = next;
      }
      if (!baseSha)
        throw new GitHubError("fatal", "A root commit has no parent diff");
      return {
        files,
        patch: await readPatch(repo, number, {
          baseSha: s.sha.parse(baseSha),
          headSha: commitSha,
        }),
      };
    },
    async readPullRequestFile(repo, range, path, ignoreWhitespace) {
      s.repo.parse(repo);
      s.sha.parse(range.baseSha);
      s.sha.parse(range.headSha);
      z.string().min(1).parse(path);
      z.boolean().parse(ignoreWhitespace);
      const { value } = await new Api(run).get(
        `repos/${repo}/compare/${range.baseSha}...${range.headSha}?per_page=1`,
        z.object({
          merge_base_commit: z.object({ sha: s.sha }),
          files: z.array(file),
        }),
      );
      const meta = value.files.find((f) => f.filename === path);
      if (!meta)
        throw new GitHubError(
          "fatal",
          "Full contents unavailable: file is outside GitHub's comparison metadata limit",
        );
      const read = async (sha: string, name: string) => {
        const raw = await run(
          [
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "--include",
            "--header",
            "Accept: application/vnd.github.raw+json",
            `repos/${repo}/contents/${name.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
          ],
          undefined,
          { stdoutLimit: 2 * 1024 * 1024 + 65536 },
        );
        const text = response(raw).body;
        if (
          raw.truncated ||
          Buffer.byteLength(text) > 2 * 1024 * 1024 ||
          text.includes("\0")
        )
          throw new GitHubError(
            "fatal",
            "Full contents unavailable for binary files or files over 2 MiB",
          );
        return text;
      };
      const [old, next] = await Promise.all([
        meta.status === "added"
          ? ""
          : read(value.merge_base_commit.sha, meta.previous_filename ?? path),
        meta.status === "removed" ? "" : read(range.headSha, path),
      ]);
      const options = {
        context: 3,
        timeout: 1000,
        ...(ignoreWhitespace
          ? {
              comparator: (a: string, b: string) =>
                a.replace(/[^\S\n]/g, "") === b.replace(/[^\S\n]/g, ""),
            }
          : {}),
      };
      const patch = createTwoFilesPatch(
        meta.previous_filename ?? path,
        path,
        old,
        next,
        undefined,
        undefined,
        options,
      );
      if (patch === undefined)
        throw new GitHubError(
          "fatal",
          "File diff exceeded the computation limit",
        );
      return { old, new: next, patch };
    },
  };
}
