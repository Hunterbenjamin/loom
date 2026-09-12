import type { InputId, McpToolName, McpTools } from "@loom/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { finding, head, now, plan } from "../../core/test/fixtures.js";
import { outputSchemas, resultSchema } from "./schemas.js";
import { createMcpServer, McpGuardError } from "./server.js";
import { setup } from "./test-support.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function connect(env = setup(), token = env.token) {
  const server = createMcpServer(env.options, token);
  const client = new Client({ name: "loom-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    ...env,
    client,
    call: async <K extends McpToolName>(name: K, args: unknown) => {
      const response = await client.callTool({
        name,
        arguments: args as Record<string, unknown>,
      });
      const result = resultSchema(outputSchemas[name]).parse(
        response.structuredContent,
      );
      expect(response.isError).toBe(!result.ok);
      expect(response.content).toEqual([
        { type: "text", text: JSON.stringify(result) },
      ]);
      return result;
    },
  };
}
const progress = {
  summary: "Working",
  stepIndex: null,
  decisions: ["Use SDK transports"],
  testResults: [],
};
const review: McpTools["submit_review"]["input"] = {
  reviewedSha: head,
  summary: "Reviewed",
  findings: [],
  verdicts: [],
  testResults: [],
};

test("lists all tools with input and output schemas; context never enters the inbox", async () => {
  const { client, call, host, run } = await connect();
  const tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name).sort()).toEqual(
    Object.keys(outputSchemas).sort(),
  );
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.outputSchema).toBeDefined();
  }
  expect(await call("get_task_context", {})).toMatchObject({
    ok: true,
    value: {
      task: {
        summary: host.state.task.summary,
        description: host.state.task.description,
      },
      run: { id: run.id },
      role: "implementer",
    },
  });
  expect(host.inputs).toEqual([]);
  expect(host.passes).toBe(0);
});
test("submit_plan reconciles and returns the committed plan version", async () => {
  const { call, host } = await connect(setup("planning", "planner"));
  expect(await call("submit_plan", { plan })).toEqual({
    ok: true,
    value: { planVersion: 1, next: "in_progress" },
  });
  expect(host.state.task.stage).toBe("in_progress");
  expect(host.inputs).toHaveLength(1);
  expect(host.passes).toBe(1);
});
test("report_progress records decisions and test results", async () => {
  const { call, host } = await connect();
  expect(
    await call("report_progress", {
      ...progress,
      stepIndex: 0,
      testResults: [
        { command: "pnpm test", outcome: "passed", summary: "Passed" },
      ],
    }),
  ).toEqual({ ok: true, value: { recorded: true } });
  expect(host.state.artifactContents.decisions).toEqual(progress.decisions);
  expect(host.state.artifactContents.test_results).toMatchObject([
    { headSha: head },
  ]);
});
test("ask_human assigns and returns the persisted question ID immediately", async () => {
  const { call, host } = await connect();
  const answer = await call("ask_human", {
    question: "Which color?",
    options: ["Blue"],
    blocking: true,
  });
  expect(answer).toEqual({
    ok: true,
    value: { questionId: host.state.questions[0]?.id, delivery: "message" },
  });
  expect(host.state.task.blocked?.reason).toBe("question");
});
test("submit_for_review returns the round opened by core", async () => {
  const { call, host } = await connect();
  expect(
    await call("submit_for_review", {
      headSha: head,
      summary: "Ready",
      testResults: [],
      handoff: { summary: "Ready", nextSteps: [] },
    }),
  ).toEqual({ ok: true, value: { round: 1 } });
  expect(host.state.task.stage).toBe("in_review");
});
test("submit_review without findings advances to human approval", async () => {
  const { call } = await connect(setup("in_review", "reviewer"));
  expect(await call("submit_review", review)).toEqual({
    ok: true,
    value: { round: 1, openBlocking: 0, next: "awaiting_approval" },
  });
});
test("submit_review assigns unique IDs and full anchors, preserving task-level findings", async () => {
  const { call, host } = await connect(setup("in_review", "reviewer"));
  const findings = ["new", "old"].map((side) => ({
    severity: "major",
    title: "Bug",
    body: "Fix",
    location: { path: "src/example.ts", side, startLine: 1, endLine: 1 },
  }));
  const result = await call("submit_review", {
    ...review,
    findings: [
      ...findings,
      { severity: "nit", title: "Task note", body: "Note", location: null },
    ],
  });
  expect(result).toMatchObject({
    ok: true,
    value: { openBlocking: 2, next: "in_progress" },
  });
  expect(host.state.findings).toHaveLength(3);
  expect(new Set(host.state.findings.map((f) => f.id)).size).toBe(3);
  expect(host.state.findings[0]?.anchor).toMatchObject({
    headSha: head,
    selectedText: "export const example = 1;",
    side: "new",
    normalization: "lf-v1",
  });
  expect(host.state.findings[1]?.anchor?.side).toBe("old");
  expect(host.state.findings[2]?.anchor).toBeNull();
});
test("resolve_finding records the fixing commit", async () => {
  const env = setup();
  env.host.state.findings = [finding()];
  const { call, host } = await connect(env);
  expect(
    await call("resolve_finding", {
      findingId: "f1",
      resolution: "fixed",
      note: "Fixed",
      commitSha: head,
    }),
  ).toEqual({ ok: true, value: { status: "addressed" } });
  expect(host.state.findings[0]?.resolution?.commitSha).toBe(head);
});
test.each([
  ["get_task_context", { taskId: "another-task" }],
  ["report_progress", { ...progress, runId: "another-run" }],
  ["ask_human", { question: "", blocking: true, options: [] }],
  ["submit_for_review", { headSha: "short" }],
  [
    "submit_review",
    {
      ...review,
      findings: [
        {
          severity: "major",
          title: "Bug",
          body: "Fix",
          location: {
            path: "../outside",
            side: "new",
            startLine: 2,
            endLine: 1,
          },
        },
      ],
    },
  ],
  ["submit_plan", { plan: { ...plan, steps: [] } }],
] as const)(
  "invalid_input for %s happens before token resolution or persistence",
  async (name, args) => {
    const env = setup();
    let resolutions = 0;
    env.options.resolveToken = () => {
      resolutions++;
      return null;
    };
    const { call, host } = await connect(env);
    expect(await call(name, args)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(resolutions).toBe(0);
    expect(host.inputs).toHaveLength(0);
  },
);
test.each(["", "unknown-token"])(
  "unknown_run for an unregistered token",
  async (token) => {
    const { call, host } = await connect(setup(), token);
    expect(await call("get_task_context", {})).toMatchObject({
      ok: false,
      error: { code: "unknown_run" },
    });
    expect(host.passes).toBe(0);
  },
);
test.each(["ended", "superseded", "canceled"])(
  "stale_run when %s, including an existing connection",
  async (reason) => {
    const { call, host, run } = await connect();
    expect((await call("get_task_context", {})).ok).toBe(true);
    if (reason === "ended") run.endedAt = now;
    if (reason === "superseded")
      host.state.runs.push({ ...run, id: `${run.id}/new` as typeof run.id });
    if (reason === "canceled") host.state.task.stage = "canceled";
    expect(await call("get_task_context", {})).toMatchObject({
      ok: false,
      error: { code: "stale_run" },
    });
    expect(await call("report_progress", progress)).toMatchObject({
      ok: false,
      error: { code: "stale_run" },
    });
    expect(host.inputs).toHaveLength(0);
  },
);
test("wrong_stage passes through the input's rejected disposition", async () => {
  const { call, host } = await connect();
  expect(await call("submit_plan", { plan })).toMatchObject({
    ok: false,
    error: { code: "wrong_stage" },
  });
  expect(host.inputs).toHaveLength(1);
  expect(host.passes).toBe(1);
});
test("guard_failed retains one details line per failed guard", async () => {
  const env = setup();
  if (env.host.observations.git?.ok)
    Object.assign(env.host.observations.git.value, {
      dirty: true,
      dirtyPaths: ["src/example.ts"],
      aheadOfBase: 0,
    });
  const { call } = await connect(env);
  const result = await call("submit_for_review", {
    headSha: "e".repeat(40),
    summary: "Ready",
    testResults: [],
    handoff: { summary: "Ready", nextSteps: [] },
  });
  expect(result).toMatchObject({ ok: false, error: { code: "guard_failed" } });
  if (!result.ok) expect(result.error.details).toHaveLength(3);
});
test("all anchor failures are actionable and persist no partial review", async () => {
  const env = setup("in_review", "reviewer");
  env.options.buildAnchor = async () => {
    throw new McpGuardError(["Blob missing", "Range missing"]);
  };
  const { call, host } = await connect(env);
  const result = await call("submit_review", {
    ...review,
    findings: [1, 2].map(() => ({
      severity: "major",
      title: "Bug",
      body: "Fix",
      location: {
        path: "src/example.ts",
        side: "new",
        startLine: 1,
        endLine: 1,
      },
    })),
  });
  expect(result).toMatchObject({ ok: false, error: { code: "guard_failed" } });
  if (!result.ok) expect(result.error.details).toHaveLength(4);
  expect(host.inputs).toEqual([]);
});
test("host liveness check catches a run ending after identity resolution", async () => {
  const env = setup();
  env.options.resolveToken = () => {
    env.run.endedAt = now;
    return { runId: env.run.id, active: true };
  };
  const { call } = await connect(env);
  expect(await call("report_progress", progress)).toMatchObject({
    ok: false,
    error: { code: "stale_run" },
  });
});
test("the in-memory host replays a persisted input idempotently", async () => {
  const { call, host } = await connect();
  await call("ask_human", {
    question: "Continue?",
    options: [],
    blocking: false,
  });
  const input = host.inputs[0];
  if (!input) throw new Error("Missing input");
  expect(await host.submit(input)).toEqual(host.dispositions.get(input.id));
  expect(host.state.questions).toHaveLength(1);
  expect(host.passes).toBe(1);
});
test("a host cannot accidentally answer with another input's disposition", async () => {
  const env = setup();
  env.options.host = {
    context: (id) => env.host.context(id),
    submit: async () => ({
      inputId: "other" as InputId,
      accepted: true,
      reply: { tool: "report_progress", value: { recorded: true } },
    }),
  };
  const { client } = await connect(env);
  await expect(
    client.callTool({ name: "report_progress", arguments: progress }),
  ).rejects.toThrow("Loom host could not complete");
});
