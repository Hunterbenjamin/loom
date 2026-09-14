import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { response } from "./gh.js";
import { createGitHubAdapter } from "./index.js";
import * as s from "./schemas.js";
import {
  body,
  checksPath,
  graphqlNode,
  graphqlPage,
  http,
  mergeRequest,
  ok,
  original,
  pr,
  required,
  reviewsPath,
  root,
  setup,
  statusesPath,
} from "./test-fixtures.js";

const detail = s.pullDetail.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/pull-detail.json", import.meta.url),
      "utf8",
    ),
  ),
);
const commits = JSON.parse(
  readFileSync(new URL("./fixtures/commits.json", import.meta.url), "utf8"),
);
const range = {
  headSha: detail.head.sha,
  baseSha: s.sha.parse("0".repeat(40)),
};
const patch = readFileSync(
  new URL("./fixtures/pull.diff", import.meta.url),
  "utf8",
);
function fixture() {
  const fake = setup();
  fake.set(pr, detail);
  fake.set(`${pr}/commits?per_page=100`, commits);
  fake.set("graphql:MERGED:", graphqlPage([graphqlNode]));
  fake.set("graphql:CLOSED:", graphqlPage([]));
  fake.set("graphql:OPEN:", graphqlPage([]));
  return fake;
}

describe("repository pull request reads", () => {
  it("reads branch existence from the actual head repository and refreshes after deletion", async () => {
    const fake = fixture();
    fake.set(pr, {
      ...detail,
      head: { ...detail.head, repo: { full_name: "fork/core" } },
    });
    const ref = `repos/fork/core/git/ref/heads/${encodeURIComponent(detail.head.ref)}`;
    fake.set(ref, {
      ref: `refs/heads/${detail.head.ref}`,
      object: { sha: detail.head.sha },
    });
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number))
        .branchExists,
    ).toBe(true);
    fake.routes.set(ref, missing());
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number))
        .branchExists,
    ).toBe(false);
    fake.set(pr, { ...detail, head: { ...detail.head, repo: null } });
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number))
        .branchExists,
    ).toBe(false);
  });

  it("reads rich detail, excludes test merge SHA, and exposes native checks and commits", async () => {
    const fake = fixture();
    fake.set(pr, {
      ...detail,
      merged: false,
      merged_at: null,
      state: "open",
      body: null,
    });
    const value = await fake.adapter.readPullRequest(
      "vuejs/core",
      detail.number,
    );
    expect(value).toMatchObject({
      number: detail.number,
      title: detail.title,
      author: "contributor",
      state: "open",
      head: detail.head.ref,
      base: "minor",
      headSha: detail.head.sha,
      body: "",
      mergeCommitSha: null,
      mergeable: "unknown",
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      commits: [
        {
          sha: detail.head.sha,
          message: "Improve tree shaking",
          author: "contributor",
        },
      ],
    });
    expect(value.checkRuns[0]).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      startedAt: null,
      completedAt: null,
    });
  });

  it.each(["open", "merged", "closed"] as const)(
    "maps %s lists with one GraphQL call and no detail reads",
    async (state) => {
      const fake = fixture();
      fake.set(`graphql:${state.toUpperCase()}:`, graphqlPage([graphqlNode]));
      const values = await fake.adapter.listPullRequests("vuejs/core", state);
      expect(values).toEqual([
        {
          viewerDidAuthor: false,
          viewerReviewRequested: false,
          reviewRequired: false,
          completedAt: null,
          number: detail.number,
          title: detail.title,
          author: "contributor",
          state,
          head: detail.head.ref,
          base: detail.base.ref,
          headSha: detail.head.sha,
          baseSha: range.baseSha,
          draft: false,
          mergeable: "unknown",
          checks: "success",
          review: "approved",
          createdAt: detail.created_at,
          updatedAt: detail.updated_at,
          url: detail.html_url,
          observedAt: "2026-09-12T00:00:00.000Z",
        },
      ]);
      expect(fake.run).toHaveBeenCalledTimes(1);
      const [args, input] = required(fake.run.mock.calls[0]);
      expect(args).toContain("graphql");
      expect(args).not.toContain("If-None-Match");
      expect(JSON.parse(required(input)).query).toContain("commits(last: 1)");
      expect(JSON.parse(required(input)).variables).toEqual({
        owner: "vuejs",
        name: "core",
        state: state.toUpperCase(),
        cursor: null,
      });
    },
  );

  it.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    [null, "none"],
  ])(
    "maps rollup %s, draft, conflicts, changes requested and deleted authors",
    async (rollup, checks) => {
      const fake = fixture();
      fake.set(
        "graphql:OPEN:",
        graphqlPage([
          {
            ...graphqlNode,
            author: null,
            isDraft: true,
            mergeable: "CONFLICTING",
            reviewDecision: "CHANGES_REQUESTED",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: rollup ? { state: rollup } : null,
                  },
                },
              ],
            },
          },
        ]),
      );
      expect(
        (await fake.adapter.listPullRequests("vuejs/core", "open"))[0],
      ).toMatchObject({
        checks,
        draft: true,
        mergeable: "conflicting",
        review: "changes_requested",
        author: null,
      });
    },
  );

  it.each(["merged", "closed"] as const)(
    "reads only the newest page of %s pull requests",
    async (state) => {
      const fake = fixture();
      const key = `graphql:${state.toUpperCase()}:`;
      fake.set(key, graphqlPage([graphqlNode], true, "next"));
      fake.set(`${key}next`, graphqlPage([{ ...graphqlNode, number: 1 }]));
      const rows = await fake.adapter.listPullRequests("vuejs/core", state);
      expect(rows.map((row) => row.number)).toEqual([detail.number]);
      expect(fake.run).toHaveBeenCalledTimes(1);
    },
  );

  it("follows cursors newest first and caches unchanged rows without timestamp churn or shared mutations", async () => {
    const fake = fixture();
    const newer = {
      ...graphqlNode,
      number: 20000,
      createdAt: "2026-09-11T00:00:00Z",
    };
    fake.set("graphql:OPEN:", graphqlPage([newer], true, "next"));
    fake.set("graphql:OPEN:next", graphqlPage([graphqlNode]));
    let now = new Date("2026-09-12T00:00:00Z");
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: fake.run,
      now: () => now,
    });
    const first = await adapter.listPullRequests("vuejs/core", "open");
    expect(first.map((row) => row.number)).toEqual([20000, detail.number]);
    expect(fake.run).toHaveBeenCalledTimes(2);
    now = new Date("2026-09-13T00:00:00Z");
    expect(await adapter.listPullRequests("vuejs/core", "open")).toEqual(first);
    required(first[0]).title = "caller mutation";
    expect(
      (await adapter.listPullRequests("vuejs/core", "open"))[0]?.title,
    ).toBe(newer.title);
    fake.set(
      "graphql:OPEN:next",
      graphqlPage([{ ...graphqlNode, reviewDecision: "CHANGES_REQUESTED" }]),
    );
    const changed = await adapter.listPullRequests("vuejs/core", "open");
    expect(changed[0]?.observedAt).toBe("2026-09-12T00:00:00.000Z");
    expect(changed[1]).toMatchObject({
      review: "changes_requested",
      observedAt: now.toISOString(),
    });
  });

  it("rejects GraphQL errors, invalid metadata, missing and repeated cursors", async () => {
    const fake = fixture();
    for (const payload of [
      {
        ...graphqlPage([graphqlNode]),
        errors: [{ message: "private diagnostic" }],
      },
      graphqlPage([{ ...graphqlNode, headRefOid: "invalid" }]),
      graphqlPage([graphqlNode], true, null),
      { data: { repository: null } },
    ]) {
      fake.set("graphql:OPEN:", payload);
      await expect(
        fake.adapter.listPullRequests("vuejs/core", "open"),
      ).rejects.toThrow(/GitHub/);
    }
    fake.set("graphql:OPEN:", graphqlPage([], true, "loop"));
    fake.set("graphql:OPEN:loop", graphqlPage([], true, "loop"));
    await expect(
      fake.adapter.listPullRequests("vuejs/core", "open"),
    ).rejects.toMatchObject({ code: "retryable" });
  });

  it("stops at the existing page cap without returning a partial list", async () => {
    let calls = 0;
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async () => {
        calls++;
        return ok(http(graphqlPage([], true, `cursor-${calls}`)));
      },
    });
    await expect(
      adapter.listPullRequests("vuejs/core", "open"),
    ).rejects.toMatchObject({ code: "retryable" });
    expect(calls).toBe(1000);
  });

  it("refreshes checks and reviews with a fresh GraphQL read", async () => {
    const fake = fixture();
    const first = await fake.adapter.readPullRequest(
      "vuejs/core",
      detail.number,
    );
    fake.set(checksPath, { total_count: 0, check_runs: [] });
    fake.set(statusesPath, {
      sha: detail.head.sha,
      state: "failure",
      total_count: 1,
    });
    const review = s.review.array().parse(body("reviews"))[1];
    if (!review) throw new Error("Missing review");
    fake.set(reviewsPath, [{ ...review, state: "CHANGES_REQUESTED" }]);
    const second = await fake.adapter.readPullRequest(
      "vuejs/core",
      detail.number,
    );
    expect(second.checks).toBe("failure");
    expect(second.review).toBe("changes_requested");
    expect(second.headSha).toBe(first.headSha);
    expect(
      fake.run.mock.calls.every(([args]) => args.includes("graphql")),
    ).toBe(true);
  });

  it("uses each reviewer's latest decision, preserving a decision across comments", async () => {
    const fake = fixture();
    const review = s.review.array().parse(body("reviews"))[1];
    if (!review) throw new Error("Missing review");
    const make = (id: number, state: string, login = "reviewer") => ({
      ...review,
      id,
      state,
      user: { login, type: "User" },
      submitted_at: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`,
    });
    fake.set(reviewsPath, [
      make(2, "APPROVED"),
      make(1, "CHANGES_REQUESTED"),
      make(3, "COMMENTED"),
    ]);
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number)).review,
    ).toBe("approved");
    fake.set(reviewsPath, [
      make(1, "APPROVED"),
      make(2, "DISMISSED"),
      make(3, "PENDING"),
    ]);
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number)).review,
    ).toBe("none");
    fake.set(reviewsPath, [
      make(1, "APPROVED"),
      make(2, "CHANGES_REQUESTED", "another"),
    ]);
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number)).review,
    ).toBe("changes_requested");
  });

  it("rejects incomplete connections and malformed metadata", async () => {
    const fake = fixture();
    fake.set(pr, { ...detail, commits: 251 });
    await expect(
      fake.adapter.readPullRequest("vuejs/core", detail.number),
    ).rejects.toMatchObject({ code: "retryable" });
    fake.set(pr, { ...detail, additions: "2" });
    await expect(
      fake.adapter.readPullRequest("vuejs/core", detail.number),
    ).rejects.toThrow();
  });

  it("reuses content on an unchanged head, refreshes checks, and invalidates on a push", async () => {
    const fake = fixture();
    await fake.adapter.readPullRequest("vuejs/core", detail.number);
    fake.set(checksPath, { total_count: 0, check_runs: [] });
    const second = await fake.adapter.readPullRequest(
      "vuejs/core",
      detail.number,
      { cached: true },
    );
    expect(second.checkRuns).toEqual([]);
    expect(fake.run).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(required(fake.run.mock.calls[1]?.[1])).variables.content,
    ).toBe(false);
    fake.set(pr, { ...detail, head: { ...detail.head, sha: "a".repeat(40) } });
    expect(
      (
        await fake.adapter.readPullRequest("vuejs/core", detail.number, {
          cached: true,
        })
      ).headSha,
    ).toBe("a".repeat(40));
    expect(fake.run).toHaveBeenCalledTimes(4);
    expect(
      JSON.parse(required(fake.run.mock.calls[3]?.[1])).variables.content,
    ).toBe(true);
  });
});

describe("bounded PR diffs", () => {
  it("pins the compare endpoint to immutable SHAs and reuses the patch without a read", async () => {
    let calls = 0;
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async (args, _input, options) => {
        calls++;
        expect(args).toContain("Accept: application/vnd.github.diff");
        expect(args).toContain(
          `repos/vuejs/core/compare/${range.baseSha}...${range.headSha}`,
        );
        expect(options?.stdoutLimit).toBeLessThan(9 * 1024 * 1024);
        return ok(`HTTP/2.0 200 OK\nContent-Type: text/plain\n\n${patch}`);
      },
    });
    for (let i = 0; i < 2; i++)
      expect(
        await adapter.readPullRequestPatch("vuejs/core", detail.number, range),
      ).toMatchObject({ ...range, patch, truncated: false });
    expect(calls).toBe(1);
  });

  it.each([0, 1, 10000000])(
    "reports byte truncation for %s extra bytes without splitting UTF-8",
    async (extra) => {
      const prefix = "diff --git a/x b/x\n";
      const value =
        prefix +
        "x".repeat(8 * 1024 * 1024 - Buffer.byteLength(prefix)) +
        "é".repeat(extra);
      const adapter = createGitHubAdapter({
        excludedAuthors: [],
        run: async () =>
          ok(`HTTP/2.0 200 OK\nContent-Type: text/plain\n\n${value}`),
      });
      const result = await adapter.readPullRequestPatch(
        "vuejs/core",
        detail.number,
        range,
      );
      expect(Buffer.byteLength(result.patch)).toBe(8 * 1024 * 1024);
      expect(result.truncated).toBe(extra > 0);
      expect(result.patch).not.toContain("�");
    },
  );

  it("propagates runner truncation and rejects JSON masquerading as a diff", async () => {
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async () => ({
        ...ok(`HTTP/2.0 200 OK\nEtag: "x"\n\n${patch}`),
        truncated: true,
      }),
    });
    expect(
      (await adapter.readPullRequestPatch("vuejs/core", detail.number, range))
        .truncated,
    ).toBe(true);
    const invalid = createGitHubAdapter({
      excludedAuthors: [],
      run: async () => ok(http({ error: "wrong media" })),
    });
    await expect(
      invalid.readPullRequestPatch("vuejs/core", detail.number, range),
    ).rejects.toMatchObject({ code: "fatal" });
  });
});

const missing = () => ({
  stdout: http({ message: "Not Found" }).replace("200 OK", "404 Not Found"),
  stderr: "",
  exitCode: 1,
});
function branchFixture(branch = original.head.ref, repo = "vuejs/core") {
  const fake = fixture();
  const ref = `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`;
  fake.set(ref, {
    ref: `refs/heads/${branch}`,
    object: { sha: original.head.sha },
  });
  return { ...fake, ref };
}

describe("confirmed PR actions", () => {
  it.each([false, true])(
    "closes and confirms even after a lost response (%s)",
    async (lost) => {
      const fake = fixture();
      fake.open();
      fake.mutate(async (args) => {
        expect(args).toEqual([
          "pr",
          "close",
          String(detail.number),
          "--repo",
          "github.com/vuejs/core",
        ]);
        fake.set(pr, { ...detail, merged: false });
        return lost
          ? { stdout: "", stderr: "error connecting", exitCode: 1 }
          : ok();
      });
      await fake.adapter.closePullRequest("vuejs/core", detail.number);
      const calls = fake.run.mock.calls.length;
      await fake.adapter.closePullRequest("vuejs/core", detail.number);
      expect(fake.run.mock.calls.length).toBe(calls + 1);
    },
  );

  it("never reports an unobserved close and preserves a merged PR", async () => {
    const fake = fixture();
    await fake.adapter.closePullRequest("vuejs/core", detail.number);
    fake.open();
    fake.mutate(async () => ok());
    await expect(
      fake.adapter.closePullRequest("vuejs/core", detail.number),
    ).rejects.toMatchObject({ code: "retryable" });
  });

  it.each([false, true])(
    "deletes a remote slash branch, including missing-reference 422 (%s)",
    async (absent) => {
      const fake = branchFixture();
      fake.mutate(async (args) => {
        expect(args).toContain("DELETE");
        expect(args).toContain(
          `${root}/git/refs/heads/${encodeURIComponent(original.head.ref)}`,
        );
        fake.routes.set(fake.ref, missing());
        return absent
          ? {
              stdout: http({ message: "Reference does not exist" }).replace(
                "200 OK",
                "422 Unprocessable Entity",
              ),
              stderr: "",
              exitCode: 1,
            }
          : ok("HTTP/2.0 204 No Content\nContent-Length: 0\n\n");
      });
      await fake.adapter.deleteBranch("vuejs/core", original.head.ref);
      await fake.adapter.deleteBranch("vuejs/core", original.head.ref);
      expect(response(fake.routes.get(fake.ref) ?? ok(), [404]).status).toBe(
        404,
      );
    },
  );

  it("does not swallow other 422 responses or claim a still-existing branch was deleted", async () => {
    const fake = branchFixture();
    fake.mutate(async () => ({
      stdout: http({ message: "Cannot delete default branch" }).replace(
        "200 OK",
        "422 Unprocessable Entity",
      ),
      stderr: "",
      exitCode: 1,
    }));
    await expect(
      fake.adapter.deleteBranch("vuejs/core", original.head.ref),
    ).rejects.toMatchObject({ code: "fatal" });
    fake.mutate(async () =>
      ok("HTTP/2.0 204 No Content\nContent-Length: 0\n\n"),
    );
    await expect(
      fake.adapter.deleteBranch("vuejs/core", original.head.ref),
    ).rejects.toMatchObject({ code: "retryable" });
  });

  it("deletes the fork head only after confirmed merge, also on an already-merged retry", async () => {
    const fake = branchFixture(original.head.ref, "fork/core");
    const merged = {
      ...detail,
      head: { ...detail.head, repo: { full_name: "fork/core" } },
    };
    fake.set(pr, { ...merged, merged: false, state: "open", mergeable: true });
    fake.mutate(async (args) => {
      if (args[0] === "pr") {
        expect(args).toContain("--squash");
        expect(args).toContain("--match-head-commit");
        expect(args).not.toContain("--delete-branch");
        fake.set(pr, merged);
        return { stdout: "", stderr: "error connecting", exitCode: 1 };
      }
      expect(args).toContain(
        `repos/fork/core/git/refs/heads/${encodeURIComponent(original.head.ref)}`,
      );
      fake.routes.set(fake.ref, missing());
      return ok("HTTP/2.0 204 No Content\nContent-Length: 0\n\n");
    });
    await expect(
      fake.adapter.mergePullRequest({ ...mergeRequest, deleteBranch: true }),
    ).resolves.toEqual({ state: "merged" });
    await expect(
      fake.adapter.mergePullRequest({ ...mergeRequest, deleteBranch: true }),
    ).resolves.toEqual({ state: "merged" });
  });

  it("does not delete before auto-merge completes or on stale approval", async () => {
    const fake = fixture();
    fake.set(pr, {
      ...detail,
      state: "open",
      merged: false,
      auto_merge: { merge_method: "squash" },
    });
    expect(
      await fake.adapter.mergePullRequest({
        ...mergeRequest,
        auto: true,
        deleteBranch: true,
      }),
    ).toEqual({ state: "auto_merge_enabled" });
    await expect(
      fake.adapter.mergePullRequest({
        ...mergeRequest,
        matchHeadSha: s.sha.parse("a".repeat(40)),
        deleteBranch: true,
      }),
    ).rejects.toMatchObject({ code: "precondition" });
    expect(fake.run.mock.calls.every(([args]) => args.includes("GET"))).toBe(
      true,
    );
  });

  it.each([
    "main..bad",
    "owner:branch",
    "branch?evil",
    "branch//bad",
    "branch.lock",
    "--all",
  ])("rejects invalid remote branch %s before calling gh", async (branch) => {
    const fake = fixture();
    await expect(
      fake.adapter.deleteBranch("vuejs/core", branch),
    ).rejects.toThrow();
    expect(fake.run).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "paginates rich detail and rejects a push between pages (%s)",
  async (pushed) => {
    const fake = fixture();
    let calls = 0;
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async (args, input) => {
        calls++;
        const native = JSON.parse(response(await fake.run(args, input)).body);
        const pull = native.data.repository.pullRequest;
        if (calls === 1) {
          pull.files.pageInfo = { hasNextPage: true, endCursor: "files-next" };
        } else {
          expect(JSON.parse(input ?? "{}").variables.cursor).toBe("files-next");
          pull.files.nodes = [
            {
              path: "second.ts",
              additions: 1,
              deletions: 0,
              changeType: "ADDED",
            },
          ];
          if (pushed) pull.headRefOid = "a".repeat(40);
        }
        return ok(http(native));
      },
    });
    if (pushed)
      await expect(
        adapter.readPullRequest("vuejs/core", detail.number),
      ).rejects.toMatchObject({ code: "retryable" });
    else
      expect(
        (await adapter.readPullRequest("vuejs/core", detail.number)).files.map(
          (f) => f.path,
        ),
      ).toEqual(["example.ts", "second.ts"]);
    expect(calls).toBe(2);
  },
);

it("posts comments through stdin and recovers lost responses without duplicates", async () => {
  const fake = fixture();
  const endpoint = `${root}/issues/${detail.number}/comments?per_page=100`;
  fake.set(endpoint, []);
  const id = "b5e9155b-4c50-49b7-876b-c6cf884cc789";
  const text = "Review `code`\n\n$(literal) **markdown**";
  let writes = 0;
  fake.mutate(async (args, input) => {
    writes++;
    expect(args).toEqual([
      "pr",
      "comment",
      String(detail.number),
      "--repo",
      "github.com/vuejs/core",
      "--body-file",
      "-",
    ]);
    expect(input).toBe(`${text}\n\n<!-- loom-comment:${id} -->`);
    fake.set(endpoint, [{ body: input }]);
    return { stdout: "", stderr: "connection lost", exitCode: 1 };
  });
  await fake.adapter.commentPullRequest("vuejs/core", detail.number, text, id);
  await fake.adapter.commentPullRequest("vuejs/core", detail.number, text, id);
  expect(writes).toBe(1);
});

it("caches branch divergence by both immutable SHAs and validates counts", async () => {
  const fake = fixture();
  const endpoint = `${root}/compare/${range.baseSha}...${range.headSha}?per_page=1`;
  fake.set(endpoint, { behind_by: 3 });
  expect(await fake.adapter.readPullRequestBehind("vuejs/core", range)).toBe(3);
  expect(await fake.adapter.readPullRequestBehind("vuejs/core", range)).toBe(3);
  expect(fake.run).toHaveBeenCalledOnce();
  const changed = { ...range, baseSha: s.sha.parse("f".repeat(40)) };
  fake.set(
    `${root}/compare/${changed.baseSha}...${changed.headSha}?per_page=1`,
    { behind_by: -1 },
  );
  await expect(
    fake.adapter.readPullRequestBehind("vuejs/core", changed),
  ).rejects.toThrow();
});

it("reads and paginates requested reviewers without dropping team requests", async () => {
  const fake = fixture();
  let calls = 0;
  const adapter = createGitHubAdapter({
    excludedAuthors: [],
    run: async (args, input) => {
      const native = JSON.parse(response(await fake.run(args, input)).body);
      calls++;
      const pull = native.data.repository.pullRequest;
      if (calls === 1)
        pull.reviewRequests = {
          nodes: [{ requestedReviewer: { login: "reviewer" } }],
          pageInfo: { hasNextPage: true, endCursor: "reviewers-next" },
        };
      else {
        expect(JSON.parse(input ?? "{}").variables.cursor).toBe(
          "reviewers-next",
        );
        pull.reviewRequests = {
          nodes: [
            { requestedReviewer: { name: "Platform team" } },
            { requestedReviewer: null },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      }
      return ok(http(native));
    },
  });
  expect(
    (await adapter.readPullRequest("vuejs/core", detail.number))
      .requestedReviewers,
  ).toEqual(["reviewer", "Platform team"]);
  expect(calls).toBe(2);
});

it("maps viewer review facts and completion time without guessing from author or branch", async () => {
  const fake = setup();
  fake.set(
    "graphql:OPEN:",
    graphqlPage([
      {
        ...graphqlNode,
        viewerDidAuthor: true,
        viewerLatestReviewRequest: { id: "request-1" },
        reviewDecision: "REVIEW_REQUIRED",
        closedAt: null,
      },
    ]),
  );
  const [row] = await fake.adapter.listPullRequests("vuejs/core", "open");
  expect(row).toMatchObject({
    viewerDidAuthor: true,
    viewerReviewRequested: true,
    reviewRequired: true,
    completedAt: null,
  });
  fake.set(
    "graphql:CLOSED:",
    graphqlPage([{ ...graphqlNode, closedAt: "2026-09-12T00:00:00Z" }]),
  );
  expect(
    (await fake.adapter.listPullRequests("vuejs/core", "closed"))[0]
      ?.completedAt,
  ).toBe("2026-09-12T00:00:00Z");
  fake.set(
    "graphql:OPEN:",
    graphqlPage([{ ...graphqlNode, viewerDidAuthor: "true" }]),
  );
  await expect(
    fake.adapter.listPullRequests("vuejs/core", "open"),
  ).rejects.toThrow();
});
