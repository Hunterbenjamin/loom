import { expect, test } from "vitest";
import { command } from "./commands.js";
import { decodeServerFrame, encodeFrame } from "./frames.js";
import { applyPatch, stateFromSnapshot } from "./patch.js";
import {
  pullRequestDetailRow,
  pullRequestKey,
  pullRequestListKey,
  pullRequestPatch,
  pullRequestRow,
} from "./pull-requests.js";
import { inScope, scopeOf, subscription } from "./subscriptions.js";
import { id, meta, sha, snapshot } from "./test-support.js";

const row = () =>
  pullRequestRow.parse({
    repoId: id.repo("example"),
    taskId: null,
    number: 17,
    title: "Example",
    author: null,
    state: "open",
    head: "feat/example",
    base: "main",
    headSha: sha(1),
    baseSha: sha(2),
    createdAt: meta.now,
    updatedAt: meta.now,
    observedAt: meta.now,
    draft: false,
    mergeable: "unknown",
    checks: "none",
    review: "none",
    url: "https://example.test/pull/17",
  });

test("PR commands and subscription scopes validate repository, PR number, head SHA and flags", () => {
  const merge = {
    kind: "merge_pull_request",
    repoId: "repo",
    number: 17,
    matchHeadSha: sha(1),
    deleteBranch: true,
  };
  expect(command.safeParse(merge).success).toBe(true);
  for (const bad of [
    { number: 0 },
    { number: 1.5 },
    { matchHeadSha: "main" },
    { deleteBranch: undefined },
    { repoId: "" },
    { auto: true },
  ])
    expect(command.safeParse({ ...merge, ...bad }).success).toBe(false);
  expect(
    subscription.parse({ kind: "pull_requests", repoId: "repo" }),
  ).toMatchObject({ state: "open" });
  expect(
    subscription.safeParse({ kind: "pull_request", repoId: "repo", number: -1 })
      .success,
  ).toBe(false);
});

test("PR state changes and deletes reach only the repository list, detail only its exact subscriber", () => {
  const value = row();
  const key = pullRequestKey(value.repoId, value.number);
  const list = scopeOf([
    { kind: "pull_requests", repoId: value.repoId, state: "open" },
  ]);
  const other = scopeOf([
    { kind: "pull_requests", repoId: id.repo("other"), state: "open" },
  ]);
  const detail = scopeOf([
    { kind: "pull_request", repoId: value.repoId, number: value.number },
  ]);
  const removed = {
    op: "delete" as const,
    collection: "pull_request" as const,
    key,
    taskId: null,
  };
  expect(inScope(list, removed)).toBe(true);
  expect(inScope(other, removed)).toBe(false);
  expect(
    inScope(list, {
      op: "upsert",
      collection: "pull_request",
      value: { ...value, state: "merged" },
    }),
  ).toBe(true);
  expect(inScope(list, { ...removed, collection: "pull_request_detail" })).toBe(
    false,
  );
  expect(
    inScope(detail, { ...removed, collection: "pull_request_detail" }),
  ).toBe(true);
  const body = snapshot();
  body.pullRequests = [value];
  const state = stateFromSnapshot(meta, body);
  expect(state.collections.pull_request.get(key)).toEqual(value);
  expect(
    applyPatch(state, { seq: meta.seq + 1, now: meta.now, changes: [removed] })
      .ok,
  ).toBe(true);
  expect(state.collections.pull_request.size).toBe(0);
});

test("an 8 MiB capped patch survives JSON escaping and protocol roundtrip", () => {
  const summary = row();
  const patch = {
    headSha: summary.headSha,
    baseSha: summary.baseSha,
    patch: "\t".repeat(8 * 1024 * 1024),
    truncated: true,
    observedAt: meta.now,
  };
  const body = snapshot();
  const { repoId: _repo, taskId: _task, ...github } = summary;
  body.pullRequestDetails = [
    {
      repoId: summary.repoId,
      taskId: null,
      number: summary.number,
      pinned: false,
      viewedFiles: [],
      behindBy: null,
      detail: {
        ...github,
        branchExists: true,
        body: "",
        mergedAt: null,
        mergeCommitSha: null,
        commits: [],
        checkRuns: [],
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        requestedReviewers: [],
        files: [],
        reviews: [],
        comments: [],
      },
      patch,
      patchLoading: false,
      patchError: null,
    },
  ];
  const complete = body.pullRequestDetails[0];
  expect(
    pullRequestDetailRow.safeParse({
      ...complete,
      patch: null,
      patchLoading: true,
    }).success,
  ).toBe(true);
  expect(
    pullRequestDetailRow.safeParse({
      ...complete,
      patch: { ...patch, headSha: sha(3) },
    }).success,
  ).toBe(false);
  expect(
    pullRequestDetailRow.safeParse({
      ...complete,
      patch: { ...patch, baseSha: sha(3) },
    }).success,
  ).toBe(false);
  const encoded = encodeFrame({
    type: "snapshot",
    ...meta,
    requestId: null,
    scope: [],
    body,
  });
  expect(decodeServerFrame(encoded).ok).toBe(true);
  expect(
    pullRequestPatch.safeParse({ ...patch, patch: `${patch.patch}x` }).success,
  ).toBe(false);
});

test("list loading state survives snapshots and patches and is scoped to its repository", () => {
  const repoId = id.repo("example");
  const key = pullRequestListKey(repoId, "open");
  const body = snapshot();
  body.pullRequestLists = [{ repoId, state: "open", loading: true }];
  const state = stateFromSnapshot(meta, body);
  expect(state.collections.pull_requests.get(key)?.loading).toBe(true);
  const change = {
    op: "upsert" as const,
    collection: "pull_requests" as const,
    value: { repoId, state: "open" as const, loading: false },
  };
  expect(
    inScope(
      scopeOf([{ kind: "pull_requests", repoId, state: "open" }]),
      change,
    ),
  ).toBe(true);
  expect(
    inScope(
      scopeOf([
        { kind: "pull_requests", repoId: id.repo("other"), state: "open" },
      ]),
      change,
    ),
  ).toBe(false);
  expect(
    inScope(scopeOf([{ kind: "pull_request", repoId, number: 1 }]), change),
  ).toBe(false);
  expect(
    applyPatch(state, { seq: meta.seq + 1, now: meta.now, changes: [change] })
      .ok,
  ).toBe(true);
  expect(state.collections.pull_requests.get(key)?.loading).toBe(false);
});
