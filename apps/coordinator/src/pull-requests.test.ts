import { createGitHubAdapter, GitHubError } from "@loom/adapter-github";
import type { PullRequestDetail } from "@loom/core";
import { FakeClock, FakeGitHub, loadScenarios } from "@loom/fake-agent";
import {
  pullRequestKey,
  pullRequestListKey,
  repoId,
  type Subscription,
  sha,
} from "@loom/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { LoomClient } from "./client.js";
import { classify } from "./executor.js";
import { PullRequestViews } from "./pull-requests.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";
import { PublishedRows } from "./views.js";

const head = sha.parse("a".repeat(40));
const nextHead = sha.parse("b".repeat(40));
const at = new FakeClock().now();
const detail = (
  number = 1,
  overrides: Partial<PullRequestDetail> = {},
): PullRequestDetail => ({
  branchExists: true,
  viewerDidAuthor: true,
  viewerReviewRequested: false,
  reviewRequired: false,
  completedAt: null,
  number,
  title: `PR ${number}`,
  author: "human",
  state: "open",
  head: `feat/pr-${number}`,
  base: "main",
  headSha: head,
  baseSha: sha.parse("0".repeat(40)),
  files: [],
  reviews: [],
  comments: [],
  createdAt: at,
  updatedAt: at,
  draft: false,
  mergeable: "mergeable",
  checks: "success",
  review: "none",
  url: `https://example.test/pull/${number}`,
  observedAt: at,
  body: "A description",
  mergedAt: null,
  mergeCommitSha: null,
  commits: [],
  checkRuns: [],
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  ...overrides,
});
const harnesses: Harness[] = [];
const clients: LoomClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const h of harnesses.splice(0)) await h.close();
});
const setup = async () => {
  const h = await createHarness({ serveProtocol: true });
  harnesses.push(h);
  return h;
};
const connect = async (h: Harness, subscriptions: Subscription[]) => {
  const client = await LoomClient.connect({
    url: h.coordinator.protocol.url as string,
    token: h.config.token,
    kind: "tracker",
    clientId: `pr-window-${clients.length}`,
    subscriptions,
  });
  clients.push(client);
  return client;
};
const listScope = (h: Harness): Subscription => ({
  kind: "pull_requests",
  repoId: h.repo.id,
  state: "open",
});
const detailScope = (h: Harness, number = 1): Subscription => ({
  kind: "pull_request",
  repoId: h.repo.id,
  number,
});

test("repository lists include off-pipeline PRs, join only this repo's task branch, and scope detail/patch per window", async () => {
  const h = await setup();
  const task = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Linked",
    description: "",
  });
  h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
  await h.coordinator.settle();
  const branch = h.store.loadTaskState(task.task.id).task.branch;
  if (!branch) throw new Error("No branch");
  h.github.setPullRequest(detail(1, { head: branch }), "diff --git a/a b/a\n");
  h.github.setPullRequest(
    detail(2, { createdAt: "2026-09-13T00:00:00.000Z" as typeof at }),
  );
  const reader = await connect(h, [listScope(h), detailScope(h)]);
  await vi.waitFor(() =>
    expect(
      reader.state?.collections.pull_request_detail.get(
        pullRequestKey(h.repo.id, 1),
      )?.patch?.headSha,
    ).toBe(head),
  );
  const rows = [...(reader.state?.collections.pull_request.values() ?? [])];
  expect(rows.map((r) => r.number)).toEqual([2, 1]);
  expect(rows.find((r) => r.number === 1)?.taskId).toBe(task.task.id);
  expect(rows.find((r) => r.number === 2)?.taskId).toBeNull();
  expect(
    reader.state?.collections.pull_request_detail.get(
      pullRequestKey(h.repo.id, 1),
    ),
  ).toMatchObject({
    taskId: task.task.id,
    detail: { body: "A description" },
    patch: { patch: "diff --git a/a b/a\n", truncated: false },
  });
  const observer = await connect(h, []);
  expect(observer.state?.collections.pull_request.size).toBe(0);
  expect(observer.state?.collections.pull_request_detail.size).toBe(0);
  const listOnly = await connect(h, [listScope(h)]);
  expect(listOnly.state?.collections.pull_request.size).toBe(2);
  expect(listOnly.state?.collections.pull_request_detail.size).toBe(0);
  await reader.subscribe([], true, [detailScope(h)]);
  expect(reader.state?.collections.pull_request_detail.size).toBe(0);
});

test("merge, close, and delete each ack once after owner refresh; already merged and vanished branches succeed", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  const merge = vi.spyOn(h.adapters.github, "mergePullRequest");
  const client = await connect(h, [listScope(h), detailScope(h)]);
  const command = {
    kind: "merge_pull_request" as const,
    repoId: h.repo.id,
    number: 1,
    matchHeadSha: head,
    deleteBranch: true,
  };
  for (let i = 0; i < 2; i++) {
    expect(await client.command(command)).toMatchObject({
      ok: true,
      result: { kind: "pull_request_action", command: "merge_pull_request" },
    });
    expect(
      client.state?.collections.pull_request_detail.get(
        pullRequestKey(h.repo.id, 1),
      )?.detail.state,
    ).toBe("merged");
    expect(h.github.branchExists("feat/pr-1")).toBe(false);
  }
  expect(merge).toHaveBeenCalledWith({
    repo: h.repo.github,
    number: 1,
    matchHeadSha: head,
    auto: false,
    deleteBranch: true,
  });
  expect(
    await client.command({
      kind: "delete_branch",
      repoId: h.repo.id,
      number: 1,
    }),
  ).toMatchObject({ ok: true });
  h.github.setPullRequest(detail(2));
  for (let i = 0; i < 2; i++) {
    expect(
      await client.command({
        kind: "close_pull_request",
        repoId: h.repo.id,
        number: 2,
      }),
    ).toMatchObject({ ok: true });
    expect(
      client.state?.collections.pull_request.get(pullRequestKey(h.repo.id, 2))
        ?.state,
    ).toBe("closed");
  }
});

test("stale SHA, pending/failed checks, unknown mergeability and open branch deletion refuse and refresh", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  const client = await connect(h, [listScope(h), detailScope(h)]);
  const merge = vi.spyOn(h.adapters.github, "mergePullRequest");
  h.github.setPullRequest(detail(1, { headSha: nextHead }));
  expect(
    await client.command({
      kind: "merge_pull_request",
      repoId: h.repo.id,
      number: 1,
      matchHeadSha: head,
      deleteBranch: false,
    }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "guard_failed",
      message: expect.stringContaining("head changed"),
    },
  });
  expect(
    client.state?.collections.pull_request_detail.get(
      pullRequestKey(h.repo.id, 1),
    )?.detail.headSha,
  ).toBe(nextHead);
  for (const patch of [
    { checks: "pending" },
    { checks: "failure" },
    { mergeable: "unknown" },
    { mergeable: "conflicting" },
    { draft: true },
  ] as Partial<PullRequestDetail>[]) {
    h.github.setPullRequest(detail(1, patch));
    expect(
      await client.command({
        kind: "merge_pull_request",
        repoId: h.repo.id,
        number: 1,
        matchHeadSha: head,
        deleteBranch: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "guard_failed" } });
  }
  expect(merge).not.toHaveBeenCalled();
  expect(
    await client.command({
      kind: "delete_branch",
      repoId: h.repo.id,
      number: 1,
    }),
  ).toMatchObject({ ok: false, error: { code: "guard_failed" } });
  expect(
    await client.command({
      kind: "refresh_pull_requests",
      repoId: repoId.parse("missing"),
      state: "open",
    }),
  ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

test("adapter preconditions use the merge_pr classification, and uncertain writes refresh without replay", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  const client = await connect(h, [listScope(h), detailScope(h)]);
  const mutation = vi
    .spyOn(h.adapters.github, "closePullRequest")
    .mockImplementation(async (repo, number) => {
      await h.github.closePullRequest(repo, number);
      throw new GitHubError("retryable", "Response lost");
    });
  expect(
    await client.command({
      kind: "close_pull_request",
      repoId: h.repo.id,
      number: 1,
    }),
  ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(
    client.state?.collections.pull_request_detail.get(
      pullRequestKey(h.repo.id, 1),
    )?.detail.state,
  ).toBe("closed");
  const error = new GitHubError("precondition", "Head changed during merge");
  expect(classify(error)).toEqual({
    code: "precondition",
    message: error.message,
  });
});

test("an app merge reaches Done only through the existing task observation path", async () => {
  const h = await setup();
  const task = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Review",
    description: "Change example",
  });
  h.coordinator.submitHuman(task.task.id, { type: "move", to: "todo" });
  await new ScenarioDriver(
    h,
    await loadScenarios(
      new URL("./fixtures/walking-skeleton.json", import.meta.url),
    ),
  ).run();
  await h.coordinator.settle();
  expect(h.store.loadTaskState(task.task.id).task.stage).toBe(
    "awaiting_approval",
  );
  h.github.ci("success");
  const pr = h.github.snapshot();
  if (!pr) throw new Error("No PR");
  const client = await connect(h, [listScope(h)]);
  expect(
    await client.command({
      kind: "merge_pull_request",
      repoId: h.repo.id,
      number: pr.number,
      matchHeadSha: pr.headSha,
      deleteBranch: true,
    }),
  ).toMatchObject({ ok: true });
  expect(h.store.loadTaskState(task.task.id).task.stage).toBe(
    "awaiting_approval",
  );
  await h.coordinator.settle();
  expect(h.store.loadTaskState(task.task.id).task.stage).toBe("done");
}, 30_000);

test("polling deduplicates windows, uses 60/30 seconds, and cancels on unsubscribe and disconnect", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  const lists = vi.spyOn(h.adapters.github, "listPullRequests");
  const patches = vi.spyOn(h.adapters.github, "readPullRequestPatch");
  const one = await connect(h, [listScope(h), detailScope(h)]);
  const two = await connect(h, [listScope(h), detailScope(h)]);
  expect(lists).toHaveBeenCalledTimes(1);
  expect(patches).toHaveBeenCalledTimes(1);
  h.clock.advance(29_999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(patches).toHaveBeenCalledTimes(1);
  h.clock.advance(1);
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.clock.advance(30_000);
  await vi.waitFor(() => expect(lists).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(1));
  await one.subscribe([], true, [listScope(h), detailScope(h)]);
  two.close();
  await vi.waitFor(() => expect(h.coordinator.protocol.clients).toBe(1));
  h.clock.advance(120_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lists).toHaveBeenCalledTimes(2);
  expect(patches).toHaveBeenCalledTimes(1);
  await one.subscribe([listScope(h)]);
  expect(lists).toHaveBeenCalledTimes(3);
});

test("detail publishes before a blocked diff, then a second patch delivers the matching diff", async () => {
  const h = await setup();
  h.github.setPullRequest(detail(), "diff --git a/a b/a\n");
  const gate = deferred();
  const read = h.adapters.github.readPullRequestPatch;
  vi.spyOn(h.adapters.github, "readPullRequestPatch").mockImplementation(
    async (...args) => {
      await gate.promise;
      return read(...args);
    },
  );
  try {
    const client = await connect(h, [listScope(h), detailScope(h)]);
    const key = pullRequestKey(h.repo.id, 1);
    await vi.waitFor(() =>
      expect(
        client.state?.collections.pull_request_detail.get(key),
      ).toMatchObject({
        detail: { body: "A description" },
        patch: null,
        patchLoading: true,
      }),
    );
    gate.release();
    await vi.waitFor(() =>
      expect(
        client.state?.collections.pull_request_detail.get(key),
      ).toMatchObject({ patch: { headSha: head }, patchLoading: false }),
    );
  } finally {
    gate.release();
  }
});

test("a mismatched diff is rejected without hiding the early overview", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  vi.spyOn(h.adapters.github, "readPullRequestPatch").mockResolvedValue({
    headSha: nextHead,
    baseSha: detail().baseSha,
    patch: "new patch",
    truncated: false,
    observedAt: at,
  });
  const client = await connect(h, [detailScope(h)]);
  await vi.waitFor(() =>
    expect(
      client.state?.collections.pull_request_detail.get(
        pullRequestKey(h.repo.id, 1),
      ),
    ).toMatchObject({
      detail: { headSha: head, body: "A description" },
      patch: null,
      patchLoading: false,
      patchError: expect.stringContaining("Refresh"),
    }),
  );
});

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a first snapshot and subscription ack arrive while GitHub is blocked, then rows arrive in a patch", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  const gate = deferred();
  const read = h.adapters.github.listPullRequests;
  const lists = vi
    .spyOn(h.adapters.github, "listPullRequests")
    .mockImplementation(async (...args) => {
      await gate.promise;
      return read(...args);
    });
  try {
    const connection = connect(h, [listScope(h)]);
    let connected = false;
    void connection.then(() => {
      connected = true;
    });
    await vi.waitFor(() => expect(connected).toBe(true));
    const client = await connection;
    expect(client.state?.collections.pull_request.size).toBe(0);
    const key = pullRequestListKey(h.repo.id, "open");
    expect(client.state?.collections.pull_requests.get(key)?.loading).toBe(
      true,
    );
    const other = await connect(h, []);
    await other.subscribe([listScope(h)]);
    expect(other.state?.collections.pull_requests.get(key)?.loading).toBe(true);
    expect(lists).toHaveBeenCalledTimes(1);
    gate.release();
    await vi.waitFor(() => {
      expect(client.state?.collections.pull_request.size).toBe(1);
      expect(other.state?.collections.pull_request.size).toBe(1);
      expect(client.state?.collections.pull_requests.get(key)?.loading).toBe(
        false,
      );
    });
  } finally {
    gate.release();
  }
});

test("a slow merged scope does not queue open or detail reads, and duplicate subscribers share each read", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  h.github.setPullRequest(detail(2, { state: "merged" }));
  const gate = deferred();
  const read = h.adapters.github.listPullRequests;
  const lists = vi
    .spyOn(h.adapters.github, "listPullRequests")
    .mockImplementation(async (repo, state) => {
      if (state === "merged") await gate.promise;
      return read(repo, state);
    });
  const merged: Subscription = {
    kind: "pull_requests",
    repoId: h.repo.id,
    state: "merged",
  };
  try {
    const slow = await connect(h, [merged]);
    const fast = await connect(h, [listScope(h), detailScope(h)]);
    await connect(h, [merged, listScope(h)]);
    await vi.waitFor(() =>
      expect(fast.state?.collections.pull_request_detail.size).toBe(1),
    );
    expect(
      fast.state?.collections.pull_request.get(pullRequestKey(h.repo.id, 1)),
    ).toBeDefined();
    expect(
      slow.state?.collections.pull_requests.get(
        pullRequestListKey(h.repo.id, "merged"),
      )?.loading,
    ).toBe(true);
    expect(lists).toHaveBeenCalledTimes(2);
    gate.release();
    await vi.waitFor(() =>
      expect(fast.state?.collections.pull_request.size).toBe(2),
    );
  } finally {
    gate.release();
  }
});

test("unchanged GraphQL polls publish no patch and failed reads retain cached rows", async () => {
  const clock = new FakeClock();
  const fake = new FakeGitHub(clock, "example/repo", "feat/pr-1");
  fake.setPullRequest(detail());
  const run = vi.fn(async (_args: string[], input?: string) => ({
    stdout: `HTTP/2.0 200 OK\nContent-Type: application/json\n\n${JSON.stringify(await fake.graphql(input ?? ""))}`,
    stderr: "",
    exitCode: 0,
  }));
  const github = createGitHubAdapter({
    excludedAuthors: [],
    run,
    now: () => new Date(clock.now()),
  });
  const id = repoId.parse("repo");
  const published = new PublishedRows();
  const patches = vi.fn();
  const onError = vi.fn();
  const views = new PullRequestViews({
    github,
    repo: () => ({ id, github: "example/repo" }) as never,
    tasks: () => [],
    replace: (owner, rows) => {
      const changes = published.replace(owner, null, rows);
      if (changes.length) patches(changes);
    },
    after: clock.after.bind(clock),
    action: async () => {},
    changed: () => {},
    onError,
  });
  const scope: Subscription = {
    kind: "pull_requests",
    repoId: id,
    state: "open",
  };
  views.subscriptions([scope]);
  await views.ensure([scope]);
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(3));
  const initial = published.rows();
  patches.mockClear();
  await views.command({
    kind: "refresh_pull_requests",
    repoId: id,
    state: "open",
  });
  clock.advance(60_000);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(patches).not.toHaveBeenCalled();
  run.mockRejectedValueOnce(new Error("GitHub unavailable"));
  await expect(
    views.command({ kind: "refresh_pull_requests", repoId: id, state: "open" }),
  ).rejects.toThrow();
  expect(published.rows()).toEqual(initial);
  expect(patches).not.toHaveBeenCalled();
  await views.stop();
});

test("cached list SHAs start detail and diff together; a pushed head gets its own range", async () => {
  const h = await setup();
  h.github.setPullRequest(detail(), "diff --git a/a b/a\n");
  const client = await connect(h, [listScope(h)]);
  const key = pullRequestKey(h.repo.id, 1);
  await vi.waitFor(() =>
    expect(client.state?.collections.pull_request.has(key)).toBe(true),
  );
  const gate = deferred();
  const read = h.adapters.github.readPullRequest;
  const details = vi
    .spyOn(h.adapters.github, "readPullRequest")
    .mockImplementation(async (...args) => {
      await gate.promise;
      return read(...args);
    });
  const patches = vi.spyOn(h.adapters.github, "readPullRequestPatch");
  h.github.setPullRequest(
    detail(1, { headSha: nextHead }),
    "diff --git a/b b/b\n",
  );
  try {
    await client.subscribe([detailScope(h)]);
    await vi.waitFor(() => {
      expect(details).toHaveBeenCalledTimes(1);
      expect(patches).toHaveBeenCalledTimes(1);
    });
    expect(client.state?.collections.pull_request_detail.has(key)).toBe(false);
    gate.release();
    await vi.waitFor(() =>
      expect(
        client.state?.collections.pull_request_detail.get(key),
      ).toMatchObject({
        detail: { headSha: nextHead },
        patch: { headSha: nextHead },
        patchLoading: false,
      }),
    );
    expect(patches).toHaveBeenCalledTimes(2);
    expect(h.logs.some((line) => /detail\/checks: \d+ms/.test(line))).toBe(
      true,
    );
    expect(h.logs.some((line) => /diff: \d+ms/.test(line))).toBe(true);
  } finally {
    gate.release();
  }
});

test("overview commands publish durable pins and manual links, and reread comments once per intent", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  const issue = h.coordinator.createTask({
    repoId: h.repo.id,
    title: "Manually linked",
    description: "",
  }).task;
  const client = await connect(h, [listScope(h), detailScope(h)]);
  const key = pullRequestKey(h.repo.id, 1);
  await vi.waitFor(() =>
    expect(
      client.state?.collections.pull_request_detail.get(key)?.patchLoading,
    ).toBe(false),
  );
  const selection = { repoId: h.repo.id, number: 1 };
  const read = () => client.state?.collections.pull_request_detail.get(key);
  expect(
    await client.command({
      kind: "pin_pull_request",
      ...selection,
      pinned: true,
    }),
  ).toMatchObject({ ok: true });
  expect(read()?.pinned).toBe(true);
  expect(
    await client.command({
      kind: "link_pull_request",
      ...selection,
      taskKey: "missing",
    }),
  ).toMatchObject({ ok: false, error: { code: "guard_failed" } });
  expect(read()?.taskId).toBeNull();
  expect(
    await client.command({
      kind: "link_pull_request",
      ...selection,
      taskKey: issue.id.toUpperCase(),
    }),
  ).toMatchObject({ ok: true });
  expect(read()?.taskId).toBe(issue.id);
  expect(client.state?.collections.pull_request.get(key)?.taskId).toBe(
    issue.id,
  );
  expect(h.store.pullRequestPreferences(h.repo.id, 1)).toEqual({
    pinned: true,
    taskId: issue.id,
  });
  const comment = {
    kind: "comment_pull_request" as const,
    ...selection,
    body: "Looks ready",
    requestId: "b5e9155b-4c50-49b7-876b-c6cf884cc789",
  };
  expect(await client.command(comment)).toMatchObject({ ok: true });
  expect(await client.command(comment)).toMatchObject({ ok: true });
  expect(read()?.detail.comments.map((c) => c.body)).toEqual(["Looks ready"]);
  expect(h.store.loadTaskState(issue.id).task.stage).toBe("backlog");
});

test("branch comparison never holds back overview or diff, and publishes an honest count", async () => {
  const h = await setup();
  h.github.setPullRequest(detail());
  let release!: (count: number) => void;
  h.adapters.github.readPullRequestBehind = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const client = await connect(h, [detailScope(h)]);
  const key = pullRequestKey(h.repo.id, 1);
  try {
    await vi.waitFor(() =>
      expect(
        client.state?.collections.pull_request_detail.get(key)?.patchLoading,
      ).toBe(false),
    );
    expect(
      client.state?.collections.pull_request_detail.get(key)?.behindBy,
    ).toBeNull();
  } finally {
    release(3);
  }
  await vi.waitFor(() =>
    expect(
      client.state?.collections.pull_request_detail.get(key)?.behindBy,
    ).toBe(3),
  );
});

test("PR Reviewed state publishes to two windows, survives reconnect, and rejects stale/foreign files", async () => {
  const h = await setup();
  const file = {
    path: "a.ts",
    additions: 1,
    deletions: 1,
    changeType: "MODIFIED" as const,
  };
  h.github.setPullRequest(detail(1, { files: [file] }));
  const first = await connect(h, [detailScope(h)]);
  const second = await connect(h, [detailScope(h)]);
  await vi.waitFor(() =>
    expect(first.state?.collections.pull_request_detail.size).toBe(1),
  );
  const command = {
    kind: "save_review_state" as const,
    repoId: h.repo.id,
    number: 1,
    change: {
      headSha: head,
      viewed: [{ fileId: file.path, path: file.path, headSha: head, at }],
    },
  };
  expect(await first.command(command)).toMatchObject({ ok: true });
  const read = (client: LoomClient) =>
    client.state?.collections.pull_request_detail.get(
      pullRequestKey(h.repo.id, 1),
    )?.viewedFiles;
  await vi.waitFor(() => expect(read(second)).toHaveLength(1));
  expect(await first.command(command)).toMatchObject({ ok: true });
  expect(read(second)).toHaveLength(1);
  first.close();
  const reopened = await connect(h, [detailScope(h)]);
  await vi.waitFor(() => expect(read(reopened)).toHaveLength(1));
  expect(
    await second.command({
      ...command,
      change: {
        headSha: head,
        viewed: [{ headSha: head, at, fileId: "foreign", path: "foreign" }],
      },
    }),
  ).toMatchObject({ ok: false });
  h.github.setPullRequest(detail(1, { files: [file], headSha: nextHead }));
  expect(await second.command(command)).toMatchObject({ ok: false });
  await second.command({
    kind: "refresh_pull_requests",
    repoId: h.repo.id,
    state: "open",
  });
  await vi.waitFor(() => expect(read(second)).toEqual([]));
});

test("commit/file reads are scoped to the observed PR head and its commit/file membership", async () => {
  const h = await setup();
  const file = {
    path: "a.ts",
    additions: 1,
    deletions: 1,
    changeType: "MODIFIED" as const,
  };
  h.github.setPullRequest(
    detail(1, {
      files: [file],
      commits: [
        {
          sha: head,
          message: "A commit",
          author: "human",
          committedAt: at,
          url: "https://example.test/commit",
        },
      ],
    }),
  );
  const client = await connect(h, [detailScope(h)]);
  const command = {
    kind: "fetch_pull_request_commit" as const,
    repoId: h.repo.id,
    number: 1,
    headSha: head,
    baseSha: detail().baseSha,
    commitSha: head,
  };
  expect(await client.command(command)).toMatchObject({
    ok: true,
    result: { kind: "pull_request_commit", diff: { patch: { headSha: head } } },
  });
  expect(
    await client.command({ ...command, commitSha: nextHead }),
  ).toMatchObject({ ok: false });
  expect(
    await client.command({
      kind: "fetch_pull_request_file",
      repoId: h.repo.id,
      number: 1,
      headSha: head,
      baseSha: detail().baseSha,
      commitSha: null,
      path: "foreign",
      ignoreWhitespace: false,
    }),
  ).toMatchObject({ ok: false });
  h.github.setPullRequest(detail(1, { baseSha: nextHead }));
  expect(
    await client.command({
      ...command,
      kind: "fetch_pull_request_file",
      commitSha: null,
      path: file.path,
      ignoreWhitespace: false,
    }),
  ).toMatchObject({
    ok: false,
    error: { message: "PR head or base changed; refresh the diff" },
  });
  h.github.setPullRequest(detail(1, { headSha: nextHead }));
  expect(await client.command(command)).toMatchObject({ ok: false });
});
