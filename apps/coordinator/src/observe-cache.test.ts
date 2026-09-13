import type { PullRequestObservation } from "@loom/core";
import { expect, test, vi } from "vitest";
import type { Adapters } from "./adapters.js";
import { PullRequestCache } from "./observe.js";

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
