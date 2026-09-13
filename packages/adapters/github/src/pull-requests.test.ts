import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { response } from "./gh.js";
import { createGitHubAdapter } from "./index.js";
import * as s from "./schemas.js";
import {
  body,
  checksPath,
  http,
  mergeRequest,
  ok,
  original,
  pr,
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
const patch = readFileSync(
  new URL("./fixtures/pull.diff", import.meta.url),
  "utf8",
);
const endpoint = (state: string) =>
  `${root}/pulls?state=${state}&sort=created&direction=desc&per_page=100`;
function fixture() {
  const fake = setup();
  fake.set(pr, detail);
  fake.set(`${pr}/commits?per_page=100`, commits);
  fake.set(endpoint("closed"), [detail]);
  fake.set(endpoint("open"), []);
  return fake;
}

describe("repository pull request reads", () => {
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

  it("lists every page newest first and separates closed from merged", async () => {
    const fake = fixture();
    const newer = {
      ...detail,
      number: 20000,
      merged: false,
      created_at: "2026-09-11T00:00:00Z",
    };
    fake.set(`${root}/pulls/20000`, newer);
    fake.set(`${root}/pulls/20000/reviews?per_page=100`, []);
    fake.set(endpoint("closed"), [detail], {
      Link: `<https://api.github.com/${endpoint("closed")}&page=2>; rel="next"`,
    });
    fake.set(`${endpoint("closed")}&page=2`, [newer]);
    expect(
      (await fake.adapter.listPullRequests("vuejs/core", "merged")).map(
        (p) => p.number,
      ),
    ).toEqual([detail.number]);
    expect(
      (await fake.adapter.listPullRequests("vuejs/core", "closed")).map(
        (p) => p.number,
      ),
    ).toEqual([20000]);
    fake.set(endpoint("open"), [detail, newer]);
    fake.set(pr, { ...detail, merged: false, state: "open" });
    fake.set(`${root}/pulls/20000`, { ...newer, state: "open" });
    const values = await fake.adapter.listPullRequests("vuejs/core", "open");
    expect(values.map((p) => p.number)).toEqual([20000, detail.number]);
    expect(values[0]).not.toHaveProperty("body");
    expect(values[0]).not.toHaveProperty("checkRuns");
  });

  it("refreshes checks and reviews despite unchanged PR ETags", async () => {
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
      fake.run.mock.calls.some(
        ([args]) =>
          args.includes(pr) && args.some((a) => a.startsWith("If-None-Match:")),
      ),
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

  it("paginates commits and rejects incomplete commit lists", async () => {
    const fake = fixture();
    fake.set(`${pr}/commits?per_page=100`, [], {
      Link: `<https://api.github.com/${pr}/commits?per_page=100&page=2>; rel="next"`,
    });
    fake.set(`${pr}/commits?per_page=100&page=2`, commits);
    expect(
      (await fake.adapter.readPullRequest("vuejs/core", detail.number)).commits,
    ).toHaveLength(1);
    fake.set(pr, { ...detail, commits: 251 });
    await expect(
      fake.adapter.readPullRequest("vuejs/core", detail.number),
    ).rejects.toMatchObject({ code: "retryable" });
  });

  it("rejects a head changing during reads and malformed metadata", async () => {
    const fake = fixture();
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async (args) => {
        const result = await fake.run(args);
        if (args.includes(checksPath))
          fake.set(pr, {
            ...detail,
            head: { ...detail.head, sha: "a".repeat(40) },
          });
        return result;
      },
    });
    await expect(
      adapter.readPullRequest("vuejs/core", detail.number),
    ).rejects.toMatchObject({ code: "retryable" });
    fake.set(pr, { ...detail, additions: "2" });
    await expect(
      fake.adapter.readPullRequest("vuejs/core", detail.number),
    ).rejects.toMatchObject({ code: "fatal" });
  });
});

describe("bounded PR diffs", () => {
  it("uses the diff media type and retains a conditional cached patch on 304", async () => {
    let calls = 0;
    const adapter = createGitHubAdapter({
      excludedAuthors: [],
      run: async (args, _input, options) => {
        expect(args).toContain("Accept: application/vnd.github.diff");
        expect(options?.stdoutLimit).toBeLessThan(9 * 1024 * 1024);
        if (calls++ === 0)
          return ok(`HTTP/2.0 200 OK\nEtag: "diff"\n\n${patch}`);
        expect(args).toContain('If-None-Match: "diff"');
        return {
          stdout: 'HTTP/2.0 304 Not Modified\nEtag: "diff"\n\n',
          stderr: "",
          exitCode: 1,
        };
      },
    });
    expect(
      await adapter.readPullRequestPatch("vuejs/core", detail.number),
    ).toMatchObject({ patch, truncated: false });
    expect(
      await adapter.readPullRequestPatch("vuejs/core", detail.number),
    ).toMatchObject({ patch, truncated: false });
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
      (await adapter.readPullRequestPatch("vuejs/core", detail.number))
        .truncated,
    ).toBe(true);
    const invalid = createGitHubAdapter({
      excludedAuthors: [],
      run: async () => ok(http({ error: "wrong media" })),
    });
    await expect(
      invalid.readPullRequestPatch("vuejs/core", detail.number),
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
