import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile, type Sha } from "@loom/core";
import { command, decodeClientFrame, encodeFrame } from "@loom/protocol";
import { openStore, type Store } from "@loom/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  base,
  command as humanCommand,
  finding,
  fixture,
  head,
  run,
} from "../../../packages/core/test/fixtures.js";
import {
  config,
  notify,
  now,
  repo,
  required,
  result,
  richState,
  task,
  taskId,
} from "../../../packages/store/test/fixtures.js";
import {
  formatCliError,
  main,
  reportCliError,
  resolveCliTaskRef,
  taskCreateCommand,
} from "./cli.js";
import { configFromEnvironment } from "./config.js";

let root: string;
let store: Store;
let output: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "loom-cli-"));
  vi.stubEnv("LOOM_INSTANCE", "test");
  vi.stubEnv("LOOM_DATA_ROOT", root);
  vi.stubEnv("LOOM_TOKEN", "fixture-token-for-cli");
  store = await openStore({ dataRoot: root, instance: "test", config, now });
  store.putRepo(repo);
  store.createTask(task());
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});
afterEach(async () => {
  store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

function seed() {
  const state = richState();
  const old = {
    ...run("reviewer", "claude", 0),
    status: "ended" as const,
    endedAt: now,
    endReason: "submitted" as const,
  };
  const reviewer = required(state.runs[2]);
  reviewer.status = "unknown";
  reviewer.unknownSince = now;
  reviewer.retryAt = now;
  reviewer.sessionEpoch = 2;
  reviewer.attempts = 3;
  reviewer.lastTurn = {
    id: "turn-failed",
    outcome: "failed",
    error: "No rollout\nTry again",
  };
  reviewer.pendingRequests = [
    {
      id: "request-1",
      generation: 2,
      kind: "command_approval",
      blocking: true,
      summary: "Run tests?",
      receivedAt: now,
    },
  ];
  state.runs = [old, ...state.runs];
  const message = required(state.messages[0]);
  state.messages.push({
    ...message,
    id: "old-message" as never,
    runId: old.id,
    purpose: "initial",
    status: "delivered",
    delivered: {
      via: "claude_user_prompt_submit",
      promptId: "prompt-1",
      at: now,
    },
    text: `First line\n${"x".repeat(90)}`,
  });
  state.findings = [
    finding("f1", {
      location: {
        headSha: "a".repeat(40) as never,
        path: "src/widget.ts",
        blobOid: null,
        side: "new",
        startLine: 12,
        endLine: 14,
        status: "moved",
        version: 1,
        mappedAt: now,
      },
    }),
    { ...finding(), id: "resolved" as never, status: "resolved" },
  ];
  for (let i = 0; i < 12; i++) notify(state, `notify-${i}`);
  expect(store.commit(taskId, result(state), 0).ok).toBe(true);
  // Advance two rows, so a receipt within the last ten is visible before reconciliation.
  for (let i = 0; i < 3; i++) {
    const claimed = required(store.outbox.claim(now, taskId));
    store.outbox.finish(claimed.key, claimed.claimVersion, {
      id: `receipt-${i}` as never,
      type: "action_result",
      key: claimed.key,
      receivedAt: now,
      result: {
        kind: "notify",
        ok: false,
        error: { code: "fatal", message: "fixture\nerror" },
      },
    });
  }
}

test("task create parses an optional summary without treating it as a description", () => {
  expect(
    taskCreateCommand([
      "issue",
      "create",
      "example-repo",
      "Short title",
      "Long description",
      "--summary",
      "One-line goal",
      "--small",
    ]),
  ).toMatchObject({
    title: "Short title",
    description: "Long description",
    summary: "One-line goal",
    size: "small",
  });
  expect(
    taskCreateCommand(["issue", "create", "example-repo", "Short title"]),
  ).toMatchObject({ description: "", summary: null });
});

test("task create preserves a 1457-character description in the full command frame", () => {
  const description = `${"  Keep `backticks`, \"double quotes\", 'single quotes' (and parentheses). ".padEnd(
    1455,
    "x",
  )}  `;
  expect(description).toHaveLength(1457);
  const value = taskCreateCommand([
    "issue",
    "create",
    "example-repo",
    "Title",
    description,
  ]);
  expect(command.safeParse(value).success).toBe(true);
  expect(
    decodeClientFrame(
      encodeFrame({ type: "command", requestId: "r1", command: value }),
    ),
  ).toMatchObject({
    ok: true,
    frame: { command: { description, summary: null } },
  });
});

test("task create treats text after -- literally and keeps option values out of positionals", () => {
  expect(
    taskCreateCommand([
      "issue",
      "create",
      "--small",
      "--summary=--literal summary",
      "--",
      "example-repo",
      "--help",
      "--summary is literal description text",
    ]),
  ).toMatchObject({
    repoId: "example-repo",
    title: "--help",
    description: "--summary is literal description text",
    summary: "--literal summary",
    size: "small",
  });
});

test("task create rejects missing option values", () => {
  expect(() =>
    taskCreateCommand(["issue", "create", "example-repo", "--summary"]),
  ).toThrow();
});

test("CLI errors preserve details for structured rejections and thrown errors", () => {
  const error = {
    code: "invalid_frame",
    message: "Frame failed the schema",
    details: ["command.title: Too big", "command.repoId: Required"],
  };
  const expected =
    "invalid_frame: Frame failed the schema\n  command.title: Too big\n  command.repoId: Required\n";
  expect(formatCliError(error)).toBe(expected);
  expect(formatCliError(Object.assign(new Error(error.message), error))).toBe(
    expected,
  );
  expect(formatCliError(new Error("Unavailable"))).toBe("Unavailable\n");
  expect(formatCliError("Unavailable")).toBe("Unavailable\n");
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  reportCliError(error);
  expect(stderr).toHaveBeenCalledWith(expected);
  expect(process.exitCode).toBe(1);
});

test("task inspect prints a complete fixture without a coordinator", async () => {
  seed();
  const before = store.loadTaskState(taskId);
  await main(["issue", "inspect", taskId]);
  expect(output).toMatchSnapshot();
  const byId = output;
  output = "";
  await main(["issue", "inspect", "1"]);
  expect(output).toBe(byId);
  expect(store.loadTaskState(taskId)).toEqual(before);
});

test("CLI issue references resolve for top-level commands such as attach", () => {
  const cliConfig = configFromEnvironment();
  expect(resolveCliTaskRef(cliConfig, "1")).toBe(taskId);
  expect(resolveCliTaskRef(cliConfig, "FIXTURE-1")).toBe(taskId);
  expect(resolveCliTaskRef(cliConfig, taskId)).toBe(taskId);
});

test("task inspect --json includes histories, receipts and pending approvals", async () => {
  seed();
  await main(["issue", "inspect", taskId, "--json"]);
  const data = JSON.parse(output);
  expect(Object.keys(data)).toEqual([
    "notes",
    "reviewHistory",
    "task",
    "runs",
    "messages",
    "questions",
    "pendingApprovals",
    "outbox",
    "findings",
  ]);
  expect(data.runs).toHaveLength(4);
  expect(data.runs[0]).toMatchObject({ id: "t1/reviewer/0", endedAt: now });
  expect(data.messages[0].messages[0]).toMatchObject({
    kind: "initial",
    status: "delivered",
    deliveredAt: now,
  });
  expect([...data.messages[0].messages[0].text]).toHaveLength(80);
  expect(data.pendingApprovals[0]).toMatchObject({
    kind: "command_approval",
    runId: "t1/reviewer/1",
  });
  expect(data.outbox).toHaveLength(10);
  expect(data.outbox[0]).toMatchObject({
    key: "notify-2",
    status: "running",
    started_at: now,
    executor_finished_at: now,
    result: { ok: false },
  });
  expect(data.findings.open).toEqual([
    {
      title: "Fix bug",
      location: {
        path: "src/widget.ts",
        startLine: 12,
        endLine: 14,
        side: "new",
        status: "moved",
      },
    },
  ]);
  expect(data.findings.counts).toEqual({
    open: 1,
    addressed: 0,
    disputed: 0,
    resolved: 1,
    fixed: 0,
    escalate: 0,
    waived: 0,
  });
});

test("empty task diagnostics omit questions and approvals in text", async () => {
  await main(["issue", "inspect", taskId]);
  expect(output).toMatchSnapshot();
  expect(output).not.toContain("Pending approvals");
});

test("unknown and missing task IDs report errors without output", async () => {
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  await main(["issue", "inspect", "missing"]);
  expect(stderr).toHaveBeenCalledWith("unknown_task: missing\n");
  expect(process.exitCode).toBe(1);
  expect(output).toBe("");
  await expect(main(["issue", "inspect"])).rejects.toThrow(
    "loom issue inspect",
  );
});

test.each(["plan_approval", "awaiting_approval"] as const)(
  "inspection shows a pending %s decision",
  async (stage) => {
    const state = richState();
    state.task.stage = stage;
    state.approvals = [];
    expect(store.commit(taskId, result(state), 0).ok).toBe(true);
    await main(["issue", "inspect", "--json", taskId]);
    expect(JSON.parse(output).pendingApprovals).toEqual([
      stage === "plan_approval"
        ? { kind: "plan", planVersion: 1 }
        : { kind: "merge", headSha: head },
    ]);
  },
);

test("inspection reports an approvable reviewed head before and after base synchronization", async () => {
  const { state, observations } = fixture("awaiting_approval");
  const worktree = required(state.worktree);
  worktree.git = { headSha: base, dirty: false, aheadOfBase: 0, at: now };
  expect(store.commit(taskId, result(state), 0).ok).toBe(true);

  async function expectApprovableHead(expectedHead: Sha) {
    output = "";
    await main(["issue", "inspect", "--json", taskId]);
    const approvals = JSON.parse(output).pendingApprovals;
    expect(approvals).toEqual([{ kind: "merge", headSha: expectedHead }]);
    observations.inputs = [
      humanCommand({ type: "approve", headSha: approvals[0].headSha }),
    ];
    expect(reconcile(store.loadTaskState(taskId), observations).inputs).toEqual([
      { inputId: "input1", accepted: true, reply: null },
    ]);
  }

  await expectApprovableHead(head);

  // Persist the next completed review after syncing an advanced base. The
  // worktree's creation-time Git cache still points at the original base.
  const rereviewed = store.loadTaskState(taskId);
  const syncedHead = "c".repeat(40) as Sha;
  const advancedBase = "d".repeat(40) as Sha;
  required(rereviewed.worktree).baseSha = advancedBase;
  rereviewed.review = {
    ...required(rereviewed.review),
    headSha: syncedHead,
    lastReviewedHead: syncedHead,
  };
  rereviewed.task.reviewRound++;
  const version = rereviewed.task.version++;
  expect(store.commit(taskId, result(rereviewed), version).ok).toBe(true);
  if (!observations.git?.ok || !observations.github?.ok)
    throw new Error("Missing owner observations");
  observations.git.value.headSha = syncedHead;
  observations.git.value.remoteHeadSha = syncedHead;
  observations.git.value.reachableCommits = [head, syncedHead];
  const pr = required(observations.github.value);
  pr.headSha = syncedHead;
  pr.ci.headSha = syncedHead;
  await expectApprovableHead(syncedHead);
});

test("inspection does not substitute a Git head for a missing reviewed head", async () => {
  const { state } = fixture("awaiting_approval");
  required(state.worktree).git = {
    headSha: head,
    dirty: false,
    aheadOfBase: 1,
    at: now,
  };
  state.review = null;
  expect(store.commit(taskId, result(state), 0).ok).toBe(true);
  await main(["issue", "inspect", "--json", taskId]);
  expect(JSON.parse(output).pendingApprovals).toEqual([
    { kind: "merge", headSha: null },
  ]);
});

test("answer-request CLI command requires correct arguments", async () => {
  const _stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);

  await expect(main(["issue", "answer-request", taskId])).rejects.toThrow(
    /loom issue answer-request/,
  );

  await expect(
    main([
      "issue",
      "answer-request",
      taskId,
      "run-id",
      "request-id",
      "invalid",
    ]),
  ).rejects.toThrow("decision must be accept, decline, or cancel");
});

test("help advertises issue commands", async () => {
  await main(["--help"]);
  expect(output).toContain("loom issue create");
  expect(output).toContain("loom issue inspect <issue>");
  expect(output).not.toMatch(/\btasks?\b/i);
});

test("rejects the retired task command group", async () => {
  await expect(main(["task", "list"])).rejects.toThrow("Unknown command task");
});
