import { GitHubError } from "@loom/adapter-github";
import type { PullRequestDetail } from "@loom/core";
import { FakeClock, FakeGitHub, loadScenarios } from "@loom/fake-agent";
import { pullRequestKey, repoId, type Subscription, sha } from "@loom/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { LoomClient } from "./client.js";
import { classify } from "./executor.js";
import { PullRequestViews } from "./pull-requests.js";
import { createHarness, type Harness, ScenarioDriver } from "./test-support.js";

const head = sha.parse("a".repeat(40));
const nextHead = sha.parse("b".repeat(40));
const at = new FakeClock().now();
const detail = (
  number = 1,
  overrides: Partial<PullRequestDetail> = {},
): PullRequestDetail => ({
  number,
  title: `PR ${number}`,
  author: "human",
  state: "open",
  head: `feat/pr-${number}`,
  base: "main",
  headSha: head,
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
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(2));
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.clock.advance(30_000);
  await vi.waitFor(() => expect(lists).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(patches).toHaveBeenCalledTimes(3));
  await one.subscribe([], true, [listScope(h), detailScope(h)]);
  two.close();
  await vi.waitFor(() => expect(h.coordinator.protocol.clients).toBe(1));
  h.clock.advance(120_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lists).toHaveBeenCalledTimes(2);
  expect(patches).toHaveBeenCalledTimes(3);
  await one.subscribe([listScope(h)]);
  expect(lists).toHaveBeenCalledTimes(3);
});

test("a patch read racing a push retains the previous complete detail", async () => {
  const clock = new FakeClock();
  const github = new FakeGitHub(clock, "example/repo", "feat/pr-1");
  github.setPullRequest(detail(), "old patch");
  const id = repoId.parse("repo");
  const replace = vi.fn();
  const onError = vi.fn();
  const views = new PullRequestViews({
    github,
    repo: () => ({ id, github: "example/repo" }) as never,
    tasks: () => [],
    replace,
    after: clock.after.bind(clock),
    action: async () => {},
    changed: () => {},
    onError,
  });
  const scope: Subscription = { kind: "pull_request", repoId: id, number: 1 };
  views.subscriptions([scope]);
  await views.ensure([scope]);
  replace.mockClear();
  vi.spyOn(github, "readPullRequestPatch").mockImplementation(async () => {
    github.setPullRequest(detail(1, { headSha: nextHead }));
    return { patch: "new patch", truncated: false, observedAt: at };
  });
  clock.advance(30_000);
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  expect(replace).not.toHaveBeenCalled();
  await views.stop();
});
