import { describe, expect, it } from "vitest";
import { createGitHubAdapter } from "./index.js";
import * as s from "./schemas.js";
import {
  body,
  checksPath,
  commentsPath,
  fixture,
  http,
  issuePath,
  list,
  mergeRequest,
  ok,
  openRequest,
  original,
  pr,
  request,
  required,
  reviewsPath,
  setup,
  statusesPath,
} from "./test-fixtures.js";

async function read(adapter: ReturnType<typeof createGitHubAdapter>) {
  const result = await adapter.findPullRequest(request);
  if (result.notModified || result.value === null)
    throw new Error("Expected PR");
  return { value: result.value, etag: result.etag };
}

describe("GitHub observations", () => {
  it("reads a recorded merged PR with stable check and review IDs", async () => {
    const { adapter } = setup();
    const { value } = await read(adapter);
    expect(value).toMatchObject({
      number: 15477,
      state: "merged",
      headSha: original.head.sha,
      mergeable: "unknown",
      autoMergeEnabled: false,
      ci: { conclusion: "success", observedAt: "2026-09-12T00:00:00.000Z" },
    });
    expect(value.ci.checks[0]?.id).toBe("102792905962");
    expect(value.reviews[0]?.id).toBe("5164348217");
    expect(value.comments).toHaveLength(1);
    expect(value.comments[0]).toMatchObject({
      id: "3976934237",
      reviewId: "5164473684",
      side: "new",
      path: "scripts/inline-enums.js",
      line: 250,
    });
  });

  it.each([
    [true, "mergeable"],
    [false, "conflicting"],
    [null, "unknown"],
  ] as const)("preserves mergeability %s", async (mergeable, expected) => {
    const fake = setup();
    fake.set(pr, { ...original, mergeable });
    expect((await read(fake.adapter)).value.mergeable).toBe(expected);
  });

  it("returns notModified only after conditionally checking every resource", async () => {
    const fake = setup();
    const first = await read(fake.adapter);
    fake.run.mockClear();
    expect(
      await fake.adapter.findPullRequest({ ...request, etag: first.etag }),
    ).toEqual({ notModified: true });
    expect(fake.run).toHaveBeenCalledTimes(8);
    expect(
      fake.run.mock.calls.every(([args]) =>
        args.some((arg) => arg.startsWith("If-None-Match: ")),
      ),
    ).toBe(true);
    expect(
      fake.run.mock.calls.every(
        ([args]) => args.includes("--include") && args.includes("GET"),
      ),
    ).toBe(true);
  });

  it("detects failing CI even when the PR resource returns 304", async () => {
    const fake = setup();
    const first = await read(fake.adapter);
    const checks = s.checks.parse(body("checks"));
    checks.check_runs[0] = {
      ...required(checks.check_runs[0]),
      conclusion: "failure",
    };
    fake.set(checksPath, checks);
    const second = await fake.adapter.findPullRequest({
      ...request,
      etag: first.etag,
    });
    expect(second).toMatchObject({
      notModified: false,
      value: { ci: { conclusion: "failure" } },
    });
  });

  it("detects new comments even with an unchanged PR ETag", async () => {
    const fake = setup();
    const first = await read(fake.adapter);
    fake.set(issuePath, [
      {
        id: 9,
        body: "Please fix",
        user: { login: "reviewer", type: "User" },
        created_at: "2026-09-12T00:00:00Z",
      },
    ]);
    const second = await fake.adapter.findPullRequest({
      ...request,
      etag: first.etag,
    });
    if (second.notModified) throw new Error("Expected changed observation");
    expect(second.value?.comments.some((comment) => comment.id === "9")).toBe(
      true,
    );
  });

  it("rebuilds a lost cache with full reads and ignores poll time in the validator", async () => {
    const fake = setup();
    const first = await read(fake.adapter);
    fake.run.mockClear();
    const restarted = createGitHubAdapter({
      excludedAuthors: [],
      run: fake.run,
      now: () => new Date("2026-09-13T00:00:00Z"),
    });
    expect(
      await restarted.findPullRequest({ ...request, etag: first.etag }),
    ).toEqual({ notModified: true });
    expect(
      fake.run.mock.calls[0]?.[0].some((arg) =>
        arg.startsWith("If-None-Match:"),
      ),
    ).toBe(false);
  });

  it("rejects 304 with no cached body, even though gh exits 1 for a real 304", async () => {
    const fake = setup();
    fake.routes.set(list, {
      stdout: fixture("not-modified"),
      stderr: "gh: HTTP 304",
      exitCode: 1,
    });
    await expect(fake.adapter.findPullRequest(request)).rejects.toMatchObject({
      code: "retryable",
    });
  });

  it("returns null for no PR and handles a subsequent new PR", async () => {
    const fake = setup();
    fake.set(list, []);
    const empty = await fake.adapter.findPullRequest(request);
    expect(empty).toMatchObject({ notModified: false, value: null });
    if (empty.notModified) throw new Error("Expected initial observation");
    expect(
      await fake.adapter.findPullRequest({ ...request, etag: empty.etag }),
    ).toEqual({ notModified: true });
    fake.routes.set(list, ok(fixture("pulls")));
    expect(
      await fake.adapter.findPullRequest({ ...request, etag: empty.etag }),
    ).toMatchObject({ notModified: false, value: { number: 15477 } });
  });

  it("prefers an open PR and excludes an unrelated fork head", async () => {
    const fake = setup();
    const summary = s.pullSummary.parse(original);
    fake.set(list, [
      {
        ...summary,
        number: 99999,
        head: { ...summary.head, label: `fork:${summary.head.ref}` },
      },
      { ...summary, number: 15478, state: "closed" },
      { ...summary, state: "open" },
    ]);
    expect((await read(fake.adapter)).value.number).toBe(15477);
    expect(fake.run.mock.calls.some(([args]) => args.includes(pr))).toBe(true);
  });

  it("paginates check runs, reviews, and both comment collections", async () => {
    const fake = setup();
    const next = `${commentsPath}&page=2`;
    const comment = required(
      s.reviewComment.array().parse(body("review-comments"))[1],
    );
    fake.set(commentsPath, [], {
      Link: `<https://api.github.com/${next}>; rel="next"`,
    });
    fake.set(next, [comment]);
    for (const [endpoint, value] of [
      [reviewsPath, body("reviews")],
      [issuePath, body("issue-comments")],
    ] as const) {
      fake.set(endpoint, [], {
        Link: `<https://api.github.com/${endpoint}&page=2>; rel="next"`,
      });
      fake.set(`${endpoint}&page=2`, value);
    }
    const checks = s.checks.parse(body("checks"));
    fake.set(
      checksPath,
      { total_count: checks.total_count, check_runs: [] },
      { Link: `<https://api.github.com/${checksPath}&page=2>; rel="next"` },
    );
    fake.set(`${checksPath}&page=2`, checks);
    const first = await read(fake.adapter);
    expect(first.value.comments[0]?.id).toBe(String(comment.id));
    expect(first.value.ci.checks).toHaveLength(checks.total_count);
    expect(first.value.reviews).toHaveLength(3);
    expect(
      await fake.adapter.findPullRequest({ ...request, etag: first.etag }),
    ).toEqual({ notModified: true });
  });

  it("discovers a page appended behind a full cached last page", async () => {
    const fake = setup();
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: "Comment",
      user: { login: "reviewer", type: "User" },
      created_at: "2026-09-12T00:00:00Z",
    }));
    fake.set(issuePath, records);
    const first = await read(fake.adapter);
    const next = `${issuePath}&page=2`;
    // Identical body and ETag, but pagination metadata now points at an appended comment.
    fake.set(issuePath, records, {
      Link: `<https://api.github.com/${next}>; rel="next"`,
    });
    fake.set(next, [{ ...required(records[0]), id: 101 }]);
    const second = await fake.adapter.findPullRequest({
      ...request,
      etag: first.etag,
    });
    if (second.notModified)
      throw new Error("New page must change the observation");
    expect(second.value?.comments.some((comment) => comment.id === "101")).toBe(
      true,
    );
  });

  it("imports a changes-requested review summary without inline comments", async () => {
    const fake = setup();
    const review = required(s.review.array().parse(body("reviews"))[1]);
    fake.set(reviewsPath, [
      {
        ...review,
        state: "CHANGES_REQUESTED",
        body: "Please address the race",
      },
    ]);
    fake.set(commentsPath, []);
    const { value } = await read(fake.adapter);
    expect(value.comments).toMatchObject([
      {
        id: review.node_id,
        reviewId: String(review.id),
        body: "Please address the race",
        commitSha: review.commit_id,
      },
    ]);
    expect(value.reviews).toMatchObject([
      { id: String(review.id), state: "changes_requested" },
    ]);
  });

  it("reports auto-merge changes even when head is unchanged", async () => {
    const fake = setup();
    const first = await read(fake.adapter);
    fake.set(pr, { ...original, auto_merge: { merge_method: "squash" } });
    const second = await fake.adapter.findPullRequest({
      ...request,
      etag: first.etag,
    });
    expect(second).toMatchObject({
      notModified: false,
      value: { autoMergeEnabled: true },
    });
  });

  it("follows pagination when looking for a PR", async () => {
    const fake = setup();
    fake.set(list, [], {
      Link: `<https://api.github.com/${list}&page=2>; rel="next"`,
    });
    fake.routes.set(`${list}&page=2`, ok(fixture("pulls")));
    expect((await read(fake.adapter)).value.number).toBe(15477);
  });

  it("follows pagination written in GitHub's numeric repository form", async () => {
    const fake = setup();
    const query = list.slice(list.indexOf("?"));
    fake.set(list, [], {
      Link: `<https://api.github.com/repositories/1365802580/pulls${query}&page=2>; rel="next"`,
    });
    fake.routes.set(
      `repositories/1365802580/pulls${query}&page=2`,
      ok(fixture("pulls")),
    );
    expect((await read(fake.adapter)).value.number).toBe(15477);
  });

  it.each([
    "https://evil.invalid/x",
    `https://api.github.com/repos/other/repo/pulls?page=2`,
    `https://api.github.com/repositories/1365802580/issues?page=2`,
  ])("rejects unsafe pagination %s", async (url) => {
    const fake = setup();
    fake.set(list, [], { Link: `<${url}>; rel="next"` });
    await expect(fake.adapter.findPullRequest(request)).rejects.toMatchObject({
      code: "fatal",
    });
  });

  it("filters configured agent accounts case-insensitively and preserves human locations", async () => {
    const fake = setup(["EDISON1105"]);
    fake.set(issuePath, [
      {
        id: 12,
        body: "human comment",
        created_at: "2026-09-12T00:00:00Z",
        user: { login: "reviewer", type: "User" },
      },
    ]);
    const { value } = await read(fake.adapter);
    expect(value.comments).toEqual([
      {
        id: "12",
        reviewId: null,
        path: null,
        line: null,
        side: null,
        commitSha: null,
        body: "human comment",
        author: "reviewer",
        createdAt: "2026-09-12T00:00:00Z",
      },
    ]);
  });

  it.each(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"])(
    "maps %s reviews",
    async (state) => {
      const fake = setup();
      const review = required(s.review.array().parse(body("reviews"))[1]);
      fake.set(reviewsPath, [
        { ...review, state },
        { ...review, id: 123, state: "PENDING", submitted_at: null },
      ]);
      expect((await read(fake.adapter)).value.reviews).toMatchObject([
        { state: state.toLowerCase() },
      ]);
    },
  );

  it("preserves outdated comment lines as null and LEFT as old", async () => {
    const fake = setup();
    const comment = required(
      s.reviewComment.array().parse(body("review-comments"))[1],
    );
    fake.set(commentsPath, [{ ...comment, line: null, side: "LEFT" }]);
    expect((await read(fake.adapter)).value.comments[0]).toMatchObject({
      line: null,
      side: "old",
      commitSha: comment.commit_id,
    });
  });

  it.each(["queued", "in_progress", "waiting", "requested", "pending"])(
    "maps active CI %s as pending",
    async (status) => {
      const fake = setup();
      const check = required(s.checks.parse(body("checks")).check_runs[0]);
      fake.set(checksPath, {
        total_count: 1,
        check_runs: [{ ...check, status, conclusion: null }],
      });
      expect((await read(fake.adapter)).value.ci.conclusion).toBe("pending");
    },
  );

  it.each([
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
  ])("maps failed CI %s", async (conclusion) => {
    const fake = setup();
    const check = required(s.checks.parse(body("checks")).check_runs[0]);
    fake.set(checksPath, {
      total_count: 1,
      check_runs: [{ ...check, conclusion }],
    });
    expect((await read(fake.adapter)).value.ci.conclusion).toBe("failure");
  });

  it.each([
    [0, "pending", "none"],
    [1, "failure", "failure"],
    [1, "pending", "pending"],
    [1, "success", "success"],
  ])(
    "handles legacy statuses without invented check IDs (%s, %s)",
    async (total_count, state, expected) => {
      const fake = setup();
      fake.set(checksPath, { total_count: 0, check_runs: [] });
      fake.set(statusesPath, { sha: original.head.sha, total_count, state });
      const { value } = await read(fake.adapter);
      expect(value.ci.conclusion).toBe(expected);
      expect(value.ci.checks).toEqual([]);
    },
  );

  it("invalidates malformed check IDs instead of inventing identities", async () => {
    const fake = setup();
    const check = required(s.checks.parse(body("checks")).check_runs[0]);
    const { id: _id, ...withoutId } = check;
    fake.set(checksPath, { total_count: 1, check_runs: [withoutId] });
    await expect(read(fake.adapter)).rejects.toMatchObject({
      code: "fatal",
      message: "Invalid GitHub response",
    });
  });

  it("fails if the head changes during a multi-resource read", async () => {
    const fake = setup();
    const run = async (args: string[]) => {
      const result = await fake.run(args);
      if (args.includes(checksPath))
        fake.set(pr, {
          ...original,
          head: { ...original.head, sha: "a".repeat(40) },
        });
      return result;
    };
    const adapter = createGitHubAdapter({ excludedAuthors: [], run });
    await expect(read(adapter)).rejects.toMatchObject({ code: "retryable" });
  });

  it("rejects invalid inputs before invoking gh", async () => {
    const fake = setup();
    await expect(
      fake.adapter.findPullRequest({ ...request, repo: "--evil" }),
    ).rejects.toThrow();
    await expect(
      fake.adapter.findPullRequest({ ...request, branch: "bad\nbranch" }),
    ).rejects.toThrow();
    expect(fake.run).not.toHaveBeenCalled();
  });
});

describe("GitHub actions", () => {
  it("returns an existing closed/merged PR without creating another", async () => {
    const fake = setup();
    expect(await fake.adapter.openPullRequest(openRequest)).toEqual({
      number: original.number,
      url: original.html_url,
    });
    expect(fake.run.mock.calls.every(([args]) => args[0] === "api")).toBe(true);
  });

  it("creates via stdin then confirms identity from GitHub JSON", async () => {
    const fake = setup();
    fake.set(list, []);
    fake.mutate(async (args, input) => {
      expect(args).toEqual([
        "pr",
        "create",
        "--repo",
        "github.com/vuejs/core",
        "--head",
        request.branch,
        "--base",
        "minor",
        "--title",
        "Title",
        "--body-file",
        "-",
      ]);
      expect(input).toBe(openRequest.body);
      fake.routes.set(list, ok(fixture("pulls")));
      return ok("untrusted human-readable URL output");
    });
    expect(await fake.adapter.openPullRequest(openRequest)).toEqual({
      number: original.number,
      url: original.html_url,
    });
  });

  it("recovers a concurrent create or lost creation response", async () => {
    const fake = setup();
    fake.set(list, []);
    fake.mutate(async () => {
      fake.routes.set(list, ok(fixture("pulls")));
      return { stdout: "", stderr: "error connecting", exitCode: 1 };
    });
    expect(await fake.adapter.openPullRequest(openRequest)).toMatchObject({
      number: original.number,
    });
  });

  it.each([false, true])(
    "always squashes and guards the approved SHA (auto=%s)",
    async (auto) => {
      const fake = setup();
      fake.open();
      fake.mutate(async (args) => {
        expect(args).toEqual([
          "pr",
          "merge",
          "15477",
          "--repo",
          "github.com/vuejs/core",
          "--squash",
          "--match-head-commit",
          original.head.sha,
          ...(auto ? ["--auto"] : []),
        ]);
        fake.set(
          pr,
          auto
            ? {
                ...original,
                merged: false,
                state: "open",
                auto_merge: { merge_method: "squash" },
              }
            : original,
        );
        return ok();
      });
      expect(
        await fake.adapter.mergePullRequest({ ...mergeRequest, auto }),
      ).toEqual({ state: auto ? "auto_merge_enabled" : "merged" });
    },
  );

  it("recognizes immediate merge even when --auto was requested", async () => {
    const fake = setup();
    fake.open();
    fake.mutate(async () => {
      fake.set(pr, original);
      return ok();
    });
    expect(
      await fake.adapter.mergePullRequest({ ...mergeRequest, auto: true }),
    ).toEqual({ state: "merged" });
  });

  it("is idempotent for an already merged approved head", async () => {
    const fake = setup();
    expect(await fake.adapter.mergePullRequest(mergeRequest)).toEqual({
      state: "merged",
    });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for already enabled squash auto-merge", async () => {
    const fake = setup();
    fake.set(pr, {
      ...original,
      merged: false,
      state: "open",
      auto_merge: { merge_method: "squash" },
    });
    expect(
      await fake.adapter.mergePullRequest({ ...mergeRequest, auto: true }),
    ).toEqual({ state: "auto_merge_enabled" });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });

  it("leaves unknown mergeability to the guarded GitHub merge command", async () => {
    const fake = setup();
    fake.set(pr, {
      ...original,
      merged: false,
      state: "open",
      mergeable: null,
    });
    fake.mutate(async () => {
      fake.set(pr, original);
      return ok();
    });
    expect(await fake.adapter.mergePullRequest(mergeRequest)).toEqual({
      state: "merged",
    });
  });

  it("returns precondition for a mismatched head without mutating", async () => {
    const fake = setup();
    fake.open();
    await expect(
      fake.adapter.mergePullRequest({
        ...mergeRequest,
        matchHeadSha: s.sha.parse("a".repeat(40)),
      }),
    ).rejects.toMatchObject({ code: "precondition" });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });

  it.each([{ state: "closed" }, { mergeable: false }])(
    "refuses a closed or conflicting PR: %s",
    async (change) => {
      const fake = setup();
      fake.set(pr, { ...original, merged: false, state: "open", ...change });
      await expect(
        fake.adapter.mergePullRequest(mergeRequest),
      ).rejects.toMatchObject({ code: "precondition" });
      expect(fake.run).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "Head branch was modified. Review and try the merge again (--match-head-commit).",
    "Pull request is not mergeable: the base branch policy prohibits the merge.",
    "GraphQL: Pull Request is not mergeable (mergePullRequest)",
  ])("maps gh merge refusal to precondition", async (stderr) => {
    const fake = setup();
    fake.open();
    fake.mutate(async () => ({ stdout: "", stderr, exitCode: 1 }));
    await expect(
      fake.adapter.mergePullRequest(mergeRequest),
    ).rejects.toMatchObject({ code: "precondition" });
  });

  it("does not claim merge success when no result is observable", async () => {
    const fake = setup();
    fake.open();
    fake.mutate(async () => ok());
    await expect(
      fake.adapter.mergePullRequest(mergeRequest),
    ).rejects.toMatchObject({ code: "retryable" });
  });

  it("disables auto-merge and succeeds when already off", async () => {
    const fake = setup();
    await fake.adapter.disableAutoMerge(mergeRequest);
    expect(fake.run).toHaveBeenCalledTimes(1);
    fake.set(pr, { ...original, auto_merge: { merge_method: "squash" } });
    fake.mutate(async (args) => {
      expect(args).toEqual([
        "pr",
        "merge",
        "15477",
        "--repo",
        "github.com/vuejs/core",
        "--disable-auto",
      ]);
      fake.set(pr, original);
      return ok();
    });
    await fake.adapter.disableAutoMerge(mergeRequest);
  });

  it("accepts a concurrent disable even if the CLI failed", async () => {
    const fake = setup();
    fake.set(pr, { ...original, auto_merge: { merge_method: "squash" } });
    fake.mutate(async () => {
      fake.set(pr, original);
      return { stdout: "", stderr: "auto merge already disabled", exitCode: 1 };
    });
    await expect(
      fake.adapter.disableAutoMerge(mergeRequest),
    ).resolves.toBeUndefined();
  });

  it.each([
    "GraphQL: Pull request auto-merge is not enabled (disablePullRequestAutoMerge)",
    "GraphQL: Pull request is already merged",
    "GraphQL: Pull request is already closed",
  ])("accepts an idempotent disable response: %s", async (stderr) => {
    const fake = setup();
    fake.set(pr, { ...original, auto_merge: { merge_method: "squash" } });
    fake.mutate(async () => ({ stdout: "", stderr, exitCode: 1 }));
    await expect(
      fake.adapter.disableAutoMerge(mergeRequest),
    ).resolves.toBeUndefined();
  });

  it.each([{ merged: true }, { state: "closed" }])(
    "accepts a PR that is already merged or closed: %s",
    async (change) => {
      const fake = setup();
      fake.set(pr, {
        ...original,
        auto_merge: { merge_method: "squash" },
        ...change,
      });
      await expect(
        fake.adapter.disableAutoMerge(mergeRequest),
      ).resolves.toBeUndefined();
    },
  );

  it("maps mutation rate limits to retryable without leaking diagnostics", async () => {
    const fake = setup();
    fake.open();
    fake.mutate(async () => ({
      stdout: "",
      stderr: "GraphQL: API rate limit exceeded for private-user",
      exitCode: 1,
    }));
    await expect(
      fake.adapter.mergePullRequest(mergeRequest),
    ).rejects.toMatchObject({
      code: "retryable",
      message: "GitHub rate limit reached",
    });
  });
});

describe("GitHub boundary failures", () => {
  it.each([
    [429, {}, "Too many requests", "retryable"],
    [403, { "X-RateLimit-Remaining": "0" }, "Forbidden", "retryable"],
    [403, { "Retry-After": "60" }, "Forbidden", "retryable"],
    [403, {}, "You have exceeded a secondary rate limit", "retryable"],
    [503, {}, "Service unavailable", "retryable"],
    [401, {}, "Bad credentials", "fatal"],
    [403, {}, "Resource not accessible", "fatal"],
    [404, {}, "Not found", "fatal"],
  ] as const)("maps API status %s", async (status, headers, message, code) => {
    const fake = setup();
    fake.routes.set(list, {
      stdout: http({ message }, headers).replace("200 OK", `${status} Failure`),
      stderr: "",
      exitCode: 1,
    });
    await expect(fake.adapter.findPullRequest(request)).rejects.toMatchObject({
      code,
    });
  });

  it("includes a redacted API status and message in fatal errors", async () => {
    const fake = setup();
    fake.routes.set(list, {
      stdout: http({ message: "Bad credentials for dev@example.com" }).replace(
        "200 OK",
        "401 Unauthorized",
      ),
      stderr: "",
      exitCode: 1,
    });
    await expect(fake.adapter.findPullRequest(request)).rejects.toMatchObject({
      code: "fatal",
      message:
        "GitHub request failed (HTTP 401): Bad credentials for [redacted-email]",
    });
  });

  it.each(["not json", '{"unexpected":"private response text"}'])(
    "rejects malformed JSON shapes without exposing payloads",
    async (content) => {
      const fake = setup();
      fake.routes.set(list, ok(`HTTP/2.0 200 OK\nEtag: "test"\n\n${content}`));
      await expect(fake.adapter.findPullRequest(request)).rejects.toMatchObject(
        { code: "fatal" },
      );
      await expect(fake.adapter.findPullRequest(request)).rejects.not.toThrow(
        "private response text",
      );
    },
  );

  it("does not commit a partial cache after a failed resource read", async () => {
    const fake = setup();
    const first = await read(fake.adapter);
    fake.routes.set(commentsPath, {
      stdout: "",
      stderr: "error connecting to api.github.com",
      exitCode: 1,
    });
    await expect(
      fake.adapter.findPullRequest({ ...request, etag: first.etag }),
    ).rejects.toMatchObject({ code: "retryable" });
    fake.routes.set(commentsPath, ok(fixture("review-comments")));
    expect(
      await fake.adapter.findPullRequest({ ...request, etag: first.etag }),
    ).toEqual({ notModified: true });
  });
});

describe("PR body replacement", () => {
  const update = {
    repo: request.repo,
    number: original.number,
    branch: request.branch,
    expectedHeadSha: original.head.sha,
    body: "New request\n\nWhat changed `literal` $(literal)",
  };
  it("writes literal content through stdin and skips an already applied body", async () => {
    const fake = setup();
    const current = {
      ...original,
      state: "open",
      merged: false,
      body: "Old body",
    };
    fake.set(pr, current);
    fake.mutate(async (args, input) => {
      expect(args).toEqual([
        "api",
        "--method",
        "PATCH",
        pr,
        "--input",
        "-",
      ]);
      expect(JSON.parse(input ?? "{}")).toEqual({ body: update.body });
      fake.set(pr, { ...current, body: update.body });
      return ok();
    });
    await fake.adapter.updatePullRequestBody(update);
    fake.run.mockClear();
    await fake.adapter.updatePullRequestBody(update);
    expect(fake.run).toHaveBeenCalledTimes(1);
  });
  it.each([
    { state: "closed" },
    { merged: true },
    { head: { ...original.head, ref: "other" } },
    { head: { ...original.head, sha: "b".repeat(40) } },
  ])("refuses changed owner state %j", async (change) => {
    const fake = setup();
    fake.set(pr, {
      ...original,
      state: "open",
      merged: false,
      body: "Old",
      ...change,
    });
    await expect(
      fake.adapter.updatePullRequestBody(update),
    ).rejects.toMatchObject({ code: "precondition" });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });
});
