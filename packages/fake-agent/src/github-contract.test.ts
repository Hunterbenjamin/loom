import { readFileSync } from "node:fs";
import type { GitHubAdapter, PullRequestDetail, Sha } from "@loom/core";
import { describe, expect, it } from "vitest";
import { createGitHubAdapter } from "../../adapters/github/src/index.js";
import {
  graphqlNode,
  graphqlPage,
  http,
  ok,
  pr,
  root,
  setup,
} from "../../adapters/github/src/test-fixtures.js";
import { FakeClock } from "./clock.js";
import { FakeGitHub } from "./owners.js";

const repo = "vuejs/core";
const raw = JSON.parse(
  readFileSync(
    new URL(
      "../../adapters/github/src/fixtures/pull-detail.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const rawCommits = JSON.parse(
  readFileSync(
    new URL("../../adapters/github/src/fixtures/commits.json", import.meta.url),
    "utf8",
  ),
);
const patch = "diff --git a/example.ts b/example.ts\n";

async function contract(kind: "fake" | "gh"): Promise<GitHubAdapter> {
  const stub = setup();
  stub.set(pr, {
    ...raw,
    state: "open",
    merged: false,
    mergeable: true,
    merged_at: null,
  });
  stub.set(`${pr}/commits?per_page=100`, rawCommits);
  const listState = (state: "OPEN" | "CLOSED" | "MERGED") => {
    for (const filter of ["OPEN", "CLOSED", "MERGED"])
      stub.set(
        `graphql:${filter}:`,
        graphqlPage(filter === state ? [graphqlNode] : []),
      );
  };
  listState("OPEN");
  const detail = await stub.adapter.readPullRequest(repo, raw.number);
  if (kind === "fake") {
    const fake = new FakeGitHub(new FakeClock(), repo, raw.head.ref);
    fake.setPullRequest(detail, patch);
    return fake;
  }
  const ref = `${root}/git/ref/heads/${encodeURIComponent(raw.head.ref)}`;
  stub.set(ref, {
    ref: `refs/heads/${raw.head.ref}`,
    object: { sha: raw.head.sha },
  });
  stub.mutate(async (args) => {
    if (args.includes("DELETE")) {
      stub.routes.set(ref, {
        stdout:
          'HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}',
        stderr: "",
        exitCode: 1,
      });
      return ok("HTTP/2.0 204 No Content\nContent-Length: 0\n\n");
    }
    if (args.includes("close")) {
      stub.set(pr, { ...raw, merged: false });
      listState("CLOSED");
    } else {
      stub.set(pr, raw);
      listState("MERGED");
    }
    return ok();
  });
  return stub.adapter;
}

for (const kind of ["fake", "gh"] as const)
  describe(`GitHub contract: ${kind}`, () => {
    it("lists and reads PRs independently of task lookup, returning detached copies", async () => {
      const github = await contract(kind);
      const first = await github.listPullRequests(repo, "open");
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        number: raw.number,
        title: raw.title,
        head: raw.head.ref,
        state: "open",
      });
      const detail = await github.readPullRequest(repo, raw.number);
      detail.title = "caller mutation";
      expect((await github.readPullRequest(repo, raw.number)).title).toBe(
        raw.title,
      );
    });
    it("closes idempotently then refreshes the owner state", async () => {
      const github = await contract(kind);
      await github.closePullRequest(repo, raw.number);
      await github.closePullRequest(repo, raw.number);
      expect((await github.readPullRequest(repo, raw.number)).state).toBe(
        "closed",
      );
      expect(await github.listPullRequests(repo, "open")).toEqual([]);
      expect(await github.listPullRequests(repo, "closed")).toHaveLength(1);
      expect(await github.listPullRequests(repo, "merged")).toEqual([]);
    });
    it("rejects a stale head, then merges and deletes idempotently", async () => {
      const github = await contract(kind);
      const req = {
        repo,
        number: raw.number,
        matchHeadSha: "a".repeat(40) as Sha,
        auto: false,
        deleteBranch: true,
      };
      await expect(github.mergePullRequest(req)).rejects.toThrow();
      req.matchHeadSha = raw.head.sha;
      await expect(github.mergePullRequest(req)).resolves.toEqual({
        state: "merged",
      });
      await expect(github.mergePullRequest(req)).resolves.toEqual({
        state: "merged",
      });
      await github.deleteBranch(repo, raw.head.ref);
      await github.closePullRequest(repo, raw.number);
      expect((await github.readPullRequest(repo, raw.number)).state).toBe(
        "merged",
      );
      expect(await github.listPullRequests(repo, "merged")).toHaveLength(1);
      expect(await github.listPullRequests(repo, "closed")).toEqual([]);
    });
  });

it("fake GitHub supports multiple off-pipeline PRs and isolated branch deletion", async () => {
  const clock = new FakeClock();
  const fake = new FakeGitHub(clock, repo, "feat/task");
  const github = await contract("gh");
  const detail: PullRequestDetail = await github.readPullRequest(
    repo,
    raw.number,
  );
  fake.setPullRequest(detail, patch);
  fake.setPullRequest(
    { ...detail, number: 20000, head: "feat/other", createdAt: clock.now() },
    patch,
  );
  expect(
    (await fake.listPullRequests(repo, "open")).map((p) => p.number),
  ).toEqual([20000, raw.number]);
  await fake.mergePullRequest({
    repo,
    number: 20000,
    matchHeadSha: detail.headSha,
    auto: false,
    deleteBranch: true,
  });
  expect(fake.branchExists("feat/other")).toBe(false);
  expect(fake.branchExists(raw.head.ref)).toBe(true);
  expect((await fake.readPullRequest(repo, raw.number)).state).toBe("open");
  expect(await fake.readPullRequestPatch(repo, raw.number)).toEqual({
    patch,
    truncated: false,
    observedAt: clock.now(),
  });
});

it("fake GraphQL maps all list states, draft, failed checks and changes requested through the real adapter", async () => {
  const fake = new FakeGitHub(new FakeClock(), repo, raw.head.ref);
  const base = await (await contract("gh")).readPullRequest(repo, raw.number);
  fake.setPullRequest({
    ...base,
    number: 1,
    draft: true,
    checks: "failure",
    review: "changes_requested",
  });
  fake.setPullRequest({ ...base, number: 2, state: "merged" });
  fake.setPullRequest({ ...base, number: 3, state: "closed" });
  const calls: string[][] = [];
  const adapter = createGitHubAdapter({
    excludedAuthors: [],
    run: async (args, input) => {
      calls.push(args);
      return ok(http(await fake.graphql(input ?? "")));
    },
  });
  expect(await adapter.listPullRequests(repo, "open")).toMatchObject([
    {
      number: 1,
      state: "open",
      draft: true,
      checks: "failure",
      review: "changes_requested",
    },
  ]);
  expect(await adapter.listPullRequests(repo, "merged")).toMatchObject([
    { number: 2, state: "merged" },
  ]);
  expect(await adapter.listPullRequests(repo, "closed")).toMatchObject([
    { number: 3, state: "closed" },
  ]);
  expect(calls).toHaveLength(3);
  expect(calls.every((args) => args[1] === "graphql")).toBe(true);
});

it("120 merged PRs require two GraphQL pages and no per-PR detail calls", async () => {
  const fake = new FakeGitHub(new FakeClock(), repo, raw.head.ref);
  const base = await (await contract("gh")).readPullRequest(repo, raw.number);
  for (let number = 1; number <= 120; number++)
    fake.setPullRequest({ ...base, number, state: "merged" });
  let calls = 0;
  const adapter = createGitHubAdapter({
    excludedAuthors: [],
    run: async (_args, input) => {
      calls++;
      return ok(http(await fake.graphql(input ?? "")));
    },
  });
  expect(await adapter.listPullRequests(repo, "merged")).toHaveLength(120);
  expect(calls).toBe(2);
});
