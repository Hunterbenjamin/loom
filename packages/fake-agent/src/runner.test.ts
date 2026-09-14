import type { ProviderSessionId, Run, Stage } from "@loom/core";
import { afterEach, expect, test } from "vitest";
import { run } from "../../core/test/fixtures.js";
import { loadScenarios, runScenario, type ScenarioOptions } from "./index.js";
import { setup } from "./test-support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function environment(name: string, stage: Stage = "todo", withPr = true) {
  const env = await setup(stage, withPr);
  cleanup.push(env.cleanup);
  const scenarios = await loadScenarios(
    new URL(`./fixtures/${name}.json`, import.meta.url),
  );
  return { ...env, scenarios };
}
function existing(
  env: Awaited<ReturnType<typeof environment>>,
  provider: Run["provider"] = "codex",
) {
  const r = run("implementer", provider);
  r.worktreePath = env.cwd;
  r.sessionId = `fake-existing-${provider}` as ProviderSessionId;
  env.state.runs = [r];
  env.adapters.providers.create(provider, env.cwd, r.sessionId, "interactive");
  return r;
}

test("design example: one fix round crosses real MCP/core and real Git to awaiting approval", async () => {
  const env = await environment("fix-round");
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
  });
  expect(result.state.task.stage).toBe("awaiting_approval");
  expect(result.state.task.reviewRound).toBe(2);
  expect(result.state.findings).toMatchObject([
    { status: "resolved", resolution: { note: "Verified" } },
  ]);
  expect(
    result.transitions.filter((t) => t.from !== t.to).map((t) => t.to),
  ).toEqual([
    "in_progress",
    "ci",
    "in_review",
    "in_progress",
    "ci",
    "in_review",
    "awaiting_approval",
  ]);
  expect(result.dispositions.filter((d) => !d.accepted)).toEqual([]);
  expect(
    result.dispositions.flatMap((d) =>
      d.accepted && d.reply ? [d.reply.tool] : [],
    ),
  ).toEqual([
    "submit_for_review",
    "submit_review",
    "resolve_finding",
    "submit_for_review",
    "submit_review",
  ]);
  expect(result.state.messages.every((m) => m.status === "delivered")).toBe(
    true,
  );
  expect(result.steps).toHaveLength(
    env.scenarios.reduce((n, s) => n + s.steps.length, 0),
  );
}, 60000);

test("headless crash has no SessionEnd and retries the recorded session after backoff", async () => {
  const env = await environment("crash-retry");
  env.state.plan = null;
  env.state.task.providers.planner = "claude";
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
  });
  const starts = result.actions.filter((a) => a.kind === "start_run");
  expect(starts).toHaveLength(2);
  expect(starts[1]).toMatchObject({
    attempt: 2,
    resume: true,
    sessionId: starts[0]?.sessionId,
  });
  expect(result.state.runs[0]).toMatchObject({ attempts: 2, status: "idle" });
  expect(
    Date.parse(env.clock.now()) - Date.parse("2026-09-12T00:00:00.000Z"),
  ).toBe(10000);
  const id = result.state.runs[0]?.sessionId;
  expect(
    id && (await env.adapters.claude.hookSummary(id)).sessionEnd,
  ).toBeNull();
}, 30000);

test("transport success without turn/started retries once then raises delivery attention", async () => {
  const env = await environment("dropped-delivery");
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
  });
  expect(result.actions.filter((a) => a.kind === "send_message")).toHaveLength(
    2,
  );
  expect(result.state.messages[0]).toMatchObject({
    status: "sent",
    delivered: null,
    attempts: 2,
    deliveryAttention: true,
  });
  const id = result.state.runs[0]?.sessionId;
  expect(id && (await env.adapters.codex.readThread(id)).turns).toEqual([]);
}, 30000);

test("a duplicate provider hint leaves delivery and progress dispositions singular", async () => {
  const env = await environment("duplicate-event");
  const hints: unknown[] = [];
  env.adapters.codex.subscribe((hint) => hints.push(hint));
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
  });
  expect(hints.at(-1)).toEqual(hints.at(-2));
  expect(result.state.messages).toHaveLength(1);
  expect(
    result.dispositions.filter(
      (d) => d.accepted && d.reply?.tool === "report_progress",
    ),
  ).toHaveLength(1);
  expect(result.transitions.filter((t) => t.to === "in_progress")).toHaveLength(
    1,
  );
}, 30000);

test("rate limit blocks with an exact cooldown and clears on a fresh provider read", async () => {
  const env = await environment("rate-limit");
  const seen: (string | null)[] = [];
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
    afterPass: (r) => {
      seen.push(r.state.task.blocked?.reason ?? null);
    },
  });
  expect(seen).toContain("provider_cooling_down");
  expect(result.actions).toContainEqual(
    expect.objectContaining({
      kind: "schedule",
      why: "cooldown_end",
      at: "2026-09-12T00:00:05.000Z",
    }),
  );
  expect(result.state.task.blocked).toBeNull();
  expect(result.state.progress?.summary).toBe("Alive");
}, 30000);

test("a human push invalidates approval and sends the new head through review", async () => {
  const env = await environment("human-push", "awaiting_approval");
  existing(env);
  env.adapters.github.ci("pending");
  let approved = false;
  const afterPass: ScenarioOptions["afterPass"] = (r) => {
    if (!approved) {
      approved = true;
      r.input({
        type: "approve",
        headSha: r.adapters.github.snapshot()
          ?.headSha as import("@loom/core").Sha,
      });
    }
  };
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
    afterPass,
  });
  expect(result.state.approvals[0]?.voidReason).toBe("new_commit");
  expect(result.actions.some((a) => a.kind === "disable_auto_merge")).toBe(
    true,
  );
  expect(result.state.task.stage).toBe("awaiting_approval");
  expect(result.state.review?.lastReviewedHead).toBe(
    await env.git("rev-parse", "HEAD"),
  );
}, 30000);

test("CI failing after approval disarms auto merge and creates one finding by native check ID", async () => {
  const env = await environment("ci-after-approval", "awaiting_approval");
  existing(env);
  env.adapters.github.ci("pending");
  let approved = false;
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
    afterPass: (r) => {
      if (!approved) {
        approved = true;
        r.input({
          type: "approve",
          headSha: r.adapters.github.snapshot()
            ?.headSha as import("@loom/core").Sha,
        });
      }
    },
  });
  expect(result.state.approvals[0]?.voidReason).toBe("ci_failed");
  expect(result.state.task.stage).toBe("in_progress");
  expect(env.adapters.github.snapshot()?.autoMergeEnabled).toBe(false);
  expect(result.state.findings).toMatchObject([
    {
      source: "ci",
      blocking: true,
      externalId: env.adapters.github.snapshot()?.ci.checks[0]?.id,
    },
  ]);
}, 30000);

test("interactive Claude vanishes without automatic relaunch", async () => {
  const env = await environment("vanished-interactive");
  env.state.config.runModes = {
    ...env.state.config.runModes,
    implementer: "interactive",
  };
  env.state.task.providers.implementer = "claude";
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
  });
  expect(result.state.runs[0]).toMatchObject({
    status: "ended",
    endReason: "vanished",
  });
  expect(result.actions.filter((a) => a.kind === "start_run")).toHaveLength(1);
  expect(result.state.task.attention.reasons).toContain("run_vanished");
}, 30000);

test("leftover steps fail immediately when a run ends", async () => {
  const env = await environment("vanished-interactive");
  env.state.config.runModes = {
    ...env.state.config.runModes,
    implementer: "interactive",
  };
  env.state.task.providers.implementer = "claude";
  env.scenarios[0]?.steps.push({ status: "idle" });
  await expect(
    runScenario({ ...env.options, scenarios: env.scenarios }),
  ).rejects.toThrow("Run ended with leftover steps");
}, 30000);

test("a dropped message expectation expires on fake time, never on transport acceptance", async () => {
  const env = await environment("dropped-delivery");
  const s = env.scenarios[0];
  if (s)
    s.steps = [{ dropDelivery: true }, { expect: "message", timeoutMs: 21000 }];
  await expect(
    runScenario({ ...env.options, scenarios: env.scenarios }),
  ).rejects.toThrow("Message timeout");
  expect(env.clock.now()).toBe("2026-09-12T00:00:21.000Z");
}, 30000);

test("provider approval waits for a native resolution and MCP questions arrive as messages", async () => {
  const env = await environment("duplicate-event");
  const script = env.scenarios[0];
  if (!script) throw new Error("Missing script");
  script.steps = [
    { expect: "message" },
    { tool: "get_task_context", input: {} },
    { request: "approval", summary: "Run tests", expect: "accept" },
    {
      tool: "ask_human",
      input: { question: "Choose a value", options: [], blocking: true },
    },
    { status: "idle" },
    { expect: "message", match: "Use two" },
    {
      tool: "report_progress",
      input: {
        summary: "Answered $QUESTION_0 at $HEAD",
        stepIndex: null,
        decisions: [],
        testResults: [],
      },
    },
  ];
  const answered = new Set<string>();
  let hostCalls = 0;
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
    mcp: (_runner, defaults) => ({
      ...defaults,
      host: {
        ...defaults.host,
        submit: async (input) => {
          hostCalls++;
          return defaults.host.submit(input);
        },
      },
    }),
    afterPass: (r) => {
      const run = r.state.runs[0];
      const request = run?.pendingRequests[0];
      if (run && request && !answered.has(request.id)) {
        answered.add(request.id);
        r.input({
          type: "answer_provider_request",
          runId: run.id,
          requestId: request.id,
          generation: request.generation,
          decision: "accept",
          answers: null,
        });
      }
      const question = r.state.questions.find((q) => q.answer === null);
      if (question && !answered.has(question.id)) {
        answered.add(question.id);
        r.input({
          type: "answer_question",
          questionId: question.id,
          answer: "Use two",
        });
      }
    },
  });
  expect(hostCalls).toBe(2); // get_task_context remains read-only.
  expect(result.state.questions[0]?.answer).toBe("Use two");
  expect(result.state.progress?.summary).toContain(
    result.state.questions[0]?.id,
  );
  expect(result.state.messages.at(-1)?.delivered?.via).toBe(
    "codex_user_message_item",
  );
}, 30000);

test("tool error expectations use the real MCP schema and per-run token checks", async () => {
  const env = await environment("duplicate-event");
  const script = env.scenarios[0];
  if (!script) throw new Error("Missing script");
  script.steps = [
    { expect: "message" },
    { tool: "report_progress", input: {}, expectError: "invalid_input" },
    { tool: "get_task_context", input: {}, expectError: "unknown_run" },
  ];
  const result = await runScenario({
    ...env.options,
    scenarios: env.scenarios,
    mcp: (_runner, defaults) => ({ ...defaults, resolveToken: () => null }),
  });
  expect(result.dispositions.filter((d) => d.accepted && d.reply)).toEqual([]);
}, 30000);

test.each([true, false])(
  "a reviewer that commits a fix is refused; the task stays in review with nothing published (existing PR: %s)",
  async (existingPr) => {
    const env = await environment("reviewer-inline", "todo", existingPr);
    const result = await runScenario({
      ...env.options,
      scenarios: env.scenarios,
    });
    expect(result.state.task.stage).toBe("in_review");
    expect(result.state.task.reviewRound).toBe(1);
    expect(result.state.findings).toEqual([]);
    expect(result.state.review?.reviewerCommits ?? []).toEqual([]);
    expect(result.state.review?.publicationPending ?? false).toBe(false);
    // Only the implementer's submission was pushed, for the CI gate.
    expect(result.actions.filter((a) => a.kind === "push_branch")).toHaveLength(
      1,
    );
    expect(result.actions.some((a) => a.kind === "open_pr")).toBe(false);
    const rejected = result.dispositions.filter((d) => !d.accepted);
    expect(rejected).toMatchObject([{ error: { code: "guard_failed" } }]);
    const [refusal] = rejected;
    if (refusal && !refusal.accepted)
      expect(refusal.error.details.join(" ")).toContain(
        "Reviewers don't commit",
      );
  },
  60000,
);

test.each(["reviewer-dirty", "reviewer-nondescendant"])(
  "%s is refused through fake provider, MCP and real Git",
  async (name) => {
    const env = await environment(name);
    const result = await runScenario({
      ...env.options,
      scenarios: env.scenarios,
      commit: async (step, runner) => {
        if (step.message === "Unrelated history")
          await env.git("reset", "--hard", "main");
        await env.options.commit?.(step, runner);
      },
    });
    expect(result.state.task.stage).toBe("in_review");
    expect(result.state.findings).toEqual([]);
    expect(result.actions.filter((a) => a.kind === "push_branch")).toHaveLength(
      1,
    );
    expect(result.dispositions.filter((d) => !d.accepted)).toMatchObject([
      { error: { code: "guard_failed" } },
    ]);
    const rejected = result.dispositions.find((d) => !d.accepted);
    if (rejected && !rejected.accepted)
      expect(rejected.error.details.join(" ")).toContain(
        name === "reviewer-dirty" ? "Clean the worktree" : "descendant",
      );
  },
  60000,
);
