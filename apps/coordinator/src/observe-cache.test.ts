import type { PullRequestObservation } from "@loom/core";
import { expect, test, vi } from "vitest";
import { now, run } from "../../../packages/core/test/fixtures.js";
import type { Adapters } from "./adapters.js";
import { observeRun, PullRequestCache } from "./observe.js";

test("run observation distinguishes failed supplemental reads from empty answers", async () => {
  const owner = {
    readThread: vi.fn().mockResolvedValue(null),
    checkResumable: vi.fn().mockRejectedValue(new Error("rollout unreadable")),
    activityAt: vi.fn(() => {
      throw new Error("events unavailable");
    }),
  };
  const observation = await observeRun(
    {
      codex: vi.fn().mockResolvedValue(owner),
      paneHost: { getPane: vi.fn().mockResolvedValue(null) },
    } as unknown as Adapters,
    now,
    run(),
  );

  expect(observation.resumable).toBeNull();
  expect(observation.activityAt).toBeNull();
  expect(observation.readFailures).toEqual({
    resumable: "rollout unreadable",
    activityAt: "events unavailable",
  });
});

test("a pre-merge read cannot refill a cache invalidated by a merge observation", async () => {
  const cache = new PullRequestCache();
  let release!: (value: {
    notModified: false;
    etag: string;
    value: PullRequestObservation | null;
  }) => void;
  const find = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ notModified: false, etag: "after", value: null });
  const adapters = { github: { findPullRequest: find } } as unknown as Adapters;
  const old = cache.read(adapters, "owner/repo", "feat/task");
  cache.forget("owner/repo", "feat/task");
  release({ notModified: false, etag: "before", value: null });
  await old;
  await cache.read(adapters, "owner/repo", "feat/task");
  expect(find).toHaveBeenLastCalledWith({
    repo: "owner/repo",
    branch: "feat/task",
    etag: null,
  });
  await cache.read(adapters, "owner/repo", "feat/task");
  expect(find).toHaveBeenLastCalledWith({
    repo: "owner/repo",
    branch: "feat/task",
    etag: "after",
  });
});
