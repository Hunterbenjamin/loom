import { expect, test } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { buildPullRequestDetails } from "../fixtures/pull-requests.js";
import { groupPrFiles, prActivity } from "./pull-request-overview.js";

test("file classification matches test suffixes and whole directory names only", () => {
  const paths = [
    "a.test.ts",
    "src/a.test.jsx",
    "test/a.ts",
    "src/tests/a.ts",
    "__tests__/fixture.json",
    "src/a.ts",
    "testing/a.ts",
    "test.ts",
    "contest/a.ts",
  ];
  const groups = groupPrFiles(
    paths.map((path) => ({
      path,
      additions: 2,
      deletions: 1,
      changeType: "MODIFIED",
    })),
  );
  expect(
    groups.map((group) => [
      group.name,
      group.files.length,
      group.additions,
      group.deletions,
    ]),
  ).toEqual([
    ["Implementation", 4, 8, 4],
    ["Tests", 5, 10, 5],
  ]);
});
test("activity sorts dated owner facts and preserves unknown dates without inventing merge events", () => {
  const row = buildPullRequestDetails(buildSnapshot().pullRequests)[0];
  if (!row) throw new Error("Missing fixture");
  const pr = row.detail;
  const commit = pr.commits[0];
  if (!commit) throw new Error("Missing commit");
  pr.commits = [{ ...commit, committedAt: null }];
  pr.comments = [
    {
      id: "c",
      author: "human",
      body: "Hi",
      createdAt: pr.createdAt,
      url: pr.url,
    },
  ];
  expect(prActivity(pr).map((event) => event.kind)).toEqual([
    "opened",
    "comment",
    "commit",
  ]);
  pr.mergedAt = pr.updatedAt;
  expect(prActivity(pr).some((event) => event.kind === "merged")).toBe(true);
});
