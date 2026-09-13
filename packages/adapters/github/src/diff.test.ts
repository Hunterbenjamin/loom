import { expect, test, vi } from "vitest";
import type { GhRunner } from "./gh.js";
import { createGitHubAdapter } from "./index.js";
import { sha } from "./schemas.js";

const head = sha.parse("a".repeat(40));
const parent = sha.parse("b".repeat(40));
const base = sha.parse("c".repeat(40));
const file = {
  filename: "new name.ts",
  previous_filename: "old name.ts",
  status: "renamed",
  additions: 1,
  deletions: 1,
};
const ok = (body: unknown, headers = "") => ({
  exitCode: 0,
  stderr: "",
  stdout: `HTTP/2.0 200 OK\r\nContent-Type: text/plain\r\n${headers}\r\n${typeof body === "string" ? body : JSON.stringify(body)}`,
});
const patch =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

test("commit diff uses its first parent, follows file pages, and rejects wrong SHAs", async () => {
  const run = vi.fn<GhRunner>(async (args) => {
    const endpoint = args.at(-1) ?? "";
    if (endpoint.endsWith("page=2"))
      return ok({
        sha: head,
        parents: [{ sha: parent }],
        files: [{ ...file, filename: "other.ts" }],
      });
    if (endpoint.includes("/commits/"))
      return ok(
        { sha: head, parents: [{ sha: parent }], files: [file] },
        `Link: <https://api.github.com/repos/owner/repo/commits/${head}?page=2>; rel="next"\r\n`,
      );
    if (endpoint === `repos/owner/repo/compare/${parent}...${head}`)
      return ok(patch);
    throw new Error("Unexpected request");
  });
  const adapter = createGitHubAdapter({ excludedAuthors: [], run });
  const value = await adapter.readPullRequestCommit("owner/repo", 1, head);
  expect(value.patch).toMatchObject({ baseSha: parent, headSha: head, patch });
  expect(value.files.map((f) => f.path)).toEqual(["new name.ts", "other.ts"]);
  expect(value.files[0]?.changeType).toBe("RENAMED");
  run.mockImplementation(async () =>
    ok({ sha: parent, parents: [], files: [] }),
  );
  await expect(
    adapter.readPullRequestCommit("owner/repo", 1, head),
  ).rejects.toThrow("SHA mismatch");
});

test("unchanged content follows owner rename metadata and merge base; whitespace diff is computed outside the renderer", async () => {
  const run = vi.fn<GhRunner>(async (args) => {
    const endpoint = args.at(-1) ?? "";
    if (endpoint.includes("/compare/"))
      return ok({ merge_base_commit: { sha: base }, files: [file] });
    if (endpoint === `repos/owner/repo/contents/old%20name.ts?ref=${base}`)
      return ok("const x = 1;\n");
    if (endpoint === `repos/owner/repo/contents/new%20name.ts?ref=${head}`)
      return ok("const x  = 1;\n");
    throw new Error("Unexpected request");
  });
  const adapter = createGitHubAdapter({ excludedAuthors: [], run });
  const range = { baseSha: parent, headSha: head };
  const visible = await adapter.readPullRequestFile(
    "owner/repo",
    range,
    file.filename,
    false,
  );
  expect(visible.patch).toContain("@@");
  const hidden = await adapter.readPullRequestFile(
    "owner/repo",
    range,
    file.filename,
    true,
  );
  expect(hidden.patch).not.toContain("@@");
  expect(hidden.old).toBe("const x = 1;\n");
  expect(hidden.new).toBe("const x  = 1;\n");
  await expect(
    adapter.readPullRequestFile("owner/repo", range, "not-in-metadata", false),
  ).rejects.toThrow("metadata limit");
  run.mockImplementation(async (args) =>
    args.at(-1)?.includes("/compare/")
      ? ok({ merge_base_commit: { sha: base }, files: [file] })
      : ok("binary\0data"),
  );
  await expect(
    adapter.readPullRequestFile("owner/repo", range, file.filename, false),
  ).rejects.toThrow("binary");
});
