// @vitest-environment happy-dom
import type { AckOutcome, Command } from "@loom/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { buildSnapshot } from "../fixtures/index.js";
import { createStore } from "./store.js";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const fixture = buildSnapshot();
  const pr = fixture.pullRequests[0];
  if (!pr) throw new Error("Missing fixture");
  const store = createStore(fixture);
  const notify = vi.fn();
  vi.stubGlobal("window", { loomHost: { notify } });
  const command: Command = {
    kind: "merge_pull_request",
    repoId: pr.repoId,
    number: pr.number,
    matchHeadSha: pr.headSha,
    deleteBranch: true,
  };
  const success: AckOutcome = {
    ok: true,
    result: {
      kind: "pull_request_action",
      command: "merge_pull_request",
      repoId: pr.repoId,
      number: pr.number,
    },
  };
  return { store, notify, command, success, pr };
}

test("notifies only after the coordinator completes the merge, even after leaving detail", async () => {
  const h = setup();
  let complete!: (outcome: AckOutcome) => void;
  h.store.setSender(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  h.store.openPullRequest({ repoId: h.pr.repoId, number: h.pr.number });
  const pending = h.store.command(h.command);
  h.store.openPullRequest(null);
  h.store.setView("all");
  expect(h.notify).not.toHaveBeenCalled();
  complete(h.success);
  expect(await pending).toEqual(h.success);
  expect(h.notify).toHaveBeenCalledExactlyOnceWith({
    id: expect.stringContaining("pr-merge:"),
    title: "Pull request merged",
    body: expect.stringContaining(
      `PR #${h.pr.number} was squash-merged and its branch deleted`,
    ),
  });
});

test("failed commands notify once and preserve the error; read-only observations do not notify", async () => {
  const h = setup();
  const failure: AckOutcome = {
    ok: false,
    error: { code: "guard_failed", message: "Head changed", details: [] },
  };
  const send = vi.fn(async () => failure);
  h.store.setSender(send);
  expect(await h.store.command(h.command)).toEqual(failure);
  expect(h.notify).toHaveBeenCalledExactlyOnceWith({
    id: expect.any(String),
    title: "Pull request merge failed",
    body: expect.stringContaining("Head changed"),
  });
  await h.store.command({
    kind: "refresh_pull_requests",
    repoId: h.pr.repoId,
    state: "open",
  });
  expect(h.notify).toHaveBeenCalledOnce();
});

test("transport loss reports uncertainty and notification failure never changes the command result", async () => {
  const h = setup();
  h.store.setSender(async () => {
    throw new Error("Connection lost");
  });
  await expect(h.store.command(h.command)).rejects.toThrow("Connection lost");
  expect(h.notify.mock.lastCall?.[0]).toMatchObject({
    title: "Pull request merge could not be confirmed",
  });
  h.notify.mockImplementation(() => {
    throw new Error("Notifications unavailable");
  });
  h.store.setSender(async () => h.success);
  expect(await h.store.command(h.command)).toEqual(h.success);
});

test("disconnected commands never produce merge notifications", async () => {
  const h = setup();
  await h.store.command(h.command);
  await createStore().command(h.command);
  expect(h.notify).not.toHaveBeenCalled();
});
