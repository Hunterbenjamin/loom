import type {
  ProviderSessionId,
  RunId,
  Sha,
  TaskId,
  WorktreePath,
} from "@loom/core";
import { expect, test } from "vitest";
import {
  FakeClock,
  FakeGitHub,
  FakePaneHost,
  FakeProviders,
  parseScenarios,
  substitute,
} from "./index.js";

const cwd = "/tmp/loom-fake" as WorktreePath;
const hash = (s: string) => `hash:${s}`;

test("JSON boundary rejects malformed variants, regexes, tools, timeouts and attempts", () => {
  const valid = {
    name: "script",
    agent: { provider: "codex", role: "implementer", mode: "interactive" },
    steps: [{ expect: "message" }],
  };
  expect(parseScenarios([valid])).toEqual([valid]);
  for (const step of [
    { status: "busy" },
    { expect: "message", match: "[" },
    { stall: -1 },
    { tool: "merge", input: {} },
    { tool: "get_task_context" },
    { crash: true, status: "idle" },
  ])
    expect(() => parseScenarios([{ ...valid, steps: [step] }])).toThrow();
  expect(() =>
    parseScenarios([{ ...valid, agent: { ...valid.agent, attempt: 0 } }]),
  ).toThrow();
});

test("runtime placeholders substitute recursively without modifying source or accepting missing IDs", () => {
  const input = {
    head: "$HEAD",
    ids: ["$FINDING_0", "answer $QUESTION_1"],
    literal: "$HEADERS",
  };
  expect(
    substitute(input, {
      head: "sha",
      findings: ["finding"],
      questions: ["q0", "q1"],
    }),
  ).toEqual({
    head: "sha",
    ids: ["finding", "answer q1"],
    literal: "$HEADERS",
  });
  expect(input.head).toBe("$HEAD");
  expect(() =>
    substitute("$FINDING_1", { head: null, findings: [], questions: [] }),
  ).toThrow("Unresolved");
});

test("fake clock orders equal-time callbacks, permits cancellation, and never moves backward", () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  clock.after(5, () => {
    calls.push("first");
    clock.after(0, () => calls.push("third"));
  });
  clock.after(5, () => calls.push("second"));
  const cancel = clock.after(2, () => calls.push("canceled"));
  cancel();
  clock.advance(5);
  expect(calls).toEqual(["first", "second", "third"]);
  expect(clock.nextDelay()).toBeNull();
  expect(() => clock.advance(-1)).toThrow();
});

test.each(["codex", "claude"] as const)(
  "%s transport ACK leaves activity unchanged until the provider receipt",
  async (provider) => {
    const clock = new FakeClock();
    const f = new FakeProviders(clock, hash);
    const id = f.create(provider, cwd);
    const at = f.get(id).activityAt;
    clock.advance(100);
    f.enqueue(id, "hello\tworld\r\n");
    expect(f.get(id).activityAt).toBe(at);
    const before = structuredClone(f.get(id).value);
    if (before.provider === "codex") expect(before.turns).toEqual([]);
    else expect(before.hooks.promptSubmits).toEqual([]);
    f.confirm(id);
    const after = f.get(id).value;
    if (after.provider === "codex")
      expect(after.turns[0]?.userMessageHashes).toEqual([
        hash("hello    world\n"),
      ]);
    else
      expect(after.hooks.promptSubmits[0]?.textHash).toBe(
        hash("hello    world\n"),
      );
    expect(f.get(id).activityAt).toBe(clock.now());
    clock.advance(10);
    if (provider === "codex") await f.codex.readThread(id);
    else await f.claude.listSessions();
    expect(f.get(id).activityAt).toBe("2026-09-12T00:00:00.100Z");
  },
);

test("Codex steering confirms a user-message item in the existing turn and rejects stale turns", async () => {
  const f = new FakeProviders(new FakeClock(), hash);
  const id = f.create("codex", cwd);
  const first = await f.codex.startTurn({ threadId: id, text: "first" });
  f.confirm(id);
  await expect(
    f.codex.steerTurn({ threadId: id, expectedTurnId: "wrong", text: "bad" }),
  ).rejects.toThrow("Stale");
  const next = await f.codex.steerTurn({
    threadId: id,
    expectedTurnId: first.turnId,
    text: "second",
  });
  expect(next.turnId).toBe(first.turnId);
  expect((await f.codex.readThread(id)).turns[0]?.userMessageHashes).toEqual([
    hash("first"),
  ]);
  f.confirm(id);
  expect((await f.codex.readThread(id)).turns).toHaveLength(1);
  expect((await f.codex.readThread(id)).turns[0]?.userMessageHashes).toEqual([
    hash("first"),
    hash("second"),
  ]);
});

test("Codex crash is unknown until recovery, retains resumability, and invalidates old request generation", async () => {
  const f = new FakeProviders(new FakeClock(), hash);
  const id = f.create("codex", cwd);
  await f.codex.startTurn({ threadId: id, text: "start" });
  f.confirm(id);
  f.request(id, "approval", "Run tests");
  const old = await f.codex.readThread(id);
  f.crash(id);
  await expect(f.codex.readThread(id)).rejects.toThrow("unavailable");
  expect(f.codex.generation()).toBeNull();
  expect(await f.codex.checkResumable(id)).toBe(true);
  const recovered = await f.codex.resumeThread(id);
  expect(recovered.generation).toBeGreaterThan(old.generation);
  expect(recovered.turns[0]?.status).toBe("interrupted");
  await expect(
    f.codex.answerRequest({
      threadId: id,
      generation: old.generation,
      requestId: old.pendingRequests[0]?.requestId ?? "",
      decision: "accept",
      answers: null,
    }),
  ).rejects.toThrow("Stale");
  recovered.turns.length = 0;
  expect((await f.codex.readThread(id)).turns).toHaveLength(1);
});

test("Claude headless launch is idempotent, a crash does not synthesize SessionEnd, and resume reuses identity", async () => {
  const f = new FakeProviders(new FakeClock(), hash);
  const req = {
    sessionId: "fake-claude" as ProviderSessionId,
    resume: false,
    cwd,
    model: "fake",
    settingsPath: "/fake/settings",
    readOnly: true,
    prompt: "work",
  };
  await f.claude.startHeadless(req);
  await f.claude.startHeadless(req);
  expect(f.get(req.sessionId).queue).toHaveLength(1);
  f.confirm(req.sessionId);
  f.crash(req.sessionId);
  expect(await f.claude.listSessions()).toEqual([]);
  expect((await f.claude.hookSummary(req.sessionId)).sessionEnd).toBeNull();
  await f.claude.startHeadless({ ...req, resume: true });
  expect((await f.claude.listSessions())[0]?.sessionId).toBe(req.sessionId);
  expect(await f.claude.headlessState(req.sessionId)).toMatchObject({
    exited: false,
  });
});

test("pane host is idempotent, records bytes only, and rejects stale generations", async () => {
  const host = new FakePaneHost();
  const workspace = await host.ensureWorkspace({
    taskId: "t" as TaskId,
    cwd,
    label: "Test",
  });
  const req = {
    ...workspace,
    runId: "t/implementer/0" as RunId,
    cwd,
    executable: "fake",
    args: [],
    env: { PATH: "/fake/bin" },
  };
  const ref = await host.ensurePane(req);
  expect(await host.ensurePane(req)).toEqual(ref);
  expect(host.launches).toHaveLength(1);
  expect(await host.pasteText(ref, "hello")).toBe("written");
  await host.closePane(ref);
  await host.closePane(ref);
  expect(await host.getPane(ref)).toMatchObject({
    dead: true,
    startCwd: cwd,
    cwd: null,
  });
  host.restart();
  expect(await host.getPane(ref)).toBeNull();
  await expect(host.pasteText(ref, "oops")).rejects.toThrow("unavailable");
  await host.ensureWorkspace({ taskId: "t" as TaskId, cwd, label: "Test" });
  expect((await host.ensurePane(req)).hostGeneration).not.toBe(
    ref.hostGeneration,
  );
});

test("GitHub keeps branch pushes separate from PR creation, conditional reads and native check IDs", async () => {
  const github = new FakeGitHub(new FakeClock(), "repo", "feat/test");
  github.setHead("a".repeat(40) as Sha);
  expect(github.snapshot()).toBeNull();
  const req = {
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    title: "Test",
    body: "Test",
  };
  expect(await github.openPullRequest(req)).toEqual(
    await github.openPullRequest(req),
  );
  const first = await github.findPullRequest({
    repo: "repo",
    branch: "feat/test",
    etag: null,
  });
  if (first.notModified) throw new Error("Expected fresh read");
  expect(
    await github.findPullRequest({
      repo: "repo",
      branch: "feat/test",
      etag: first.etag,
    }),
  ).toEqual({ notModified: true });
  const id = github.snapshot()?.ci.checks[0]?.id;
  github.ci("failure");
  expect(github.snapshot()?.ci.checks[0]?.id).toBe(id);
  github.setHead("b".repeat(40) as Sha);
  expect(github.snapshot()?.ci.checks[0]?.id).not.toBe(id);
  await expect(
    github.mergePullRequest({
      repo: "repo",
      number: 1,
      matchHeadSha: "a".repeat(40) as Sha,
      auto: true,
    }),
  ).rejects.toThrow("Head precondition");
  github.comment("Please fix", "example.txt", 1, true);
  expect(github.snapshot()?.reviews[0]?.state).toBe("changes_requested");
});
