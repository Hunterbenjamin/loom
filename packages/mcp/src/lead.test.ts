import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test, vi } from "vitest";
import { leadInputSchemas, leadToolNames } from "./lead.js";
import { createMcpServer } from "./server.js";
import { setup } from "./test-support.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
async function connect(lead: boolean) {
  const env = setup();
  const invoke = vi.fn(async () => ({ recorded: true }));
  const server = createMcpServer(
    {
      ...env.options,
      leadHost: { invoke },
      resolveToken: (token) =>
        token === "lead-token"
          ? { kind: "lead", active: true, repoId: "repo-loom" }
          : env.options.resolveToken(token),
    },
    lead ? "lead-token" : env.token,
  );
  const client = new Client({ name: "lead-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, invoke, env };
}
test("Main sees only its tool set and cannot submit task-run results", async () => {
  const { client, invoke, env } = await connect(true);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
    leadToolNames,
  );
  const response = await client.callTool({
    name: "get_task_context",
    arguments: {},
  });
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({
    ok: false,
    error: { code: "guard_failed" },
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(env.host.inputs).toEqual([]);
});
test("run tokens cannot call any Main tool, even by naming one directly", async () => {
  const { client, invoke } = await connect(false);
  for (const name of leadToolNames) {
    const response = await client.callTool({ name, arguments: {} });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: "guard_failed" },
    });
  }
  expect(invoke).not.toHaveBeenCalled();
});
test("Main inputs are strict and validated before reaching the host", async () => {
  const { client, invoke } = await connect(true);
  await client.callTool({ name: "list_tasks", arguments: {} });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("list_tasks", {}, "repo-loom");
  const invalid = await client.callTool({
    name: "approve_merge",
    arguments: { taskId: "task", headSha: "wrong" },
  });
  expect(invalid.isError).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  for (const schema of Object.values(leadInputSchemas))
    expect(schema.safeParse({ unexpected: true }).success).toBe(false);
});

test("answer_pane_prompt is in the tool list", async () => {
  const { client } = await connect(true);
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name)).toContain("answer_pane_prompt");
});

test("answer_pane_prompt schema validates numeric and string choices", async () => {
  const schema = leadInputSchemas.answer_pane_prompt;
  expect(schema).toBeDefined();
  if (!schema) return;
  expect(
    schema.safeParse({ taskId: "task_01", runId: "run_01", choice: 5 }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      taskId: "task_01",
      runId: "run_01",
      choice: "enter",
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      taskId: "task_01",
      runId: "run_01",
      choice: "escape",
    }).success,
  ).toBe(true);
});

test("answer_pane_prompt schema rejects invalid choices", async () => {
  const schema = leadInputSchemas.answer_pane_prompt;
  expect(schema).toBeDefined();
  if (!schema) return;

  // Out of range number
  expect(
    schema.safeParse({ taskId: "task_01", runId: "run_01", choice: 10 })
      .success,
  ).toBe(false);

  // Negative number
  expect(
    schema.safeParse({ taskId: "task_01", runId: "run_01", choice: -1 })
      .success,
  ).toBe(false);

  // Invalid string
  expect(
    schema.safeParse({ taskId: "task_01", runId: "run_01", choice: "invalid" })
      .success,
  ).toBe(false);

  // Missing runId
  expect(schema.safeParse({ taskId: "task_01", choice: 5 }).success).toBe(
    false,
  );
});

test("set_note accepts replacement and clearing, and rejects invalid or oversized input", async () => {
  const { client, invoke } = await connect(true);
  for (const note of ["", "x".repeat(2000)]) {
    expect(
      (await client.callTool({ name: "set_note", arguments: { note } }))
        .isError,
    ).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("set_note", { note }, "repo-loom");
  }
  for (const input of [
    {},
    { note: 1 },
    { note: "x".repeat(2001) },
    { note: "ok", path: "/other" },
  ])
    expect(
      (await client.callTool({ name: "set_note", arguments: input }))
        .structuredContent,
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(invoke).toHaveBeenCalledTimes(2);
});

test("Main is never granted terminal attach tools", async () => {
  const { client, invoke } = await connect(true);
  expect(
    (await client.listTools()).tools
      .map((t) => t.name)
      .some((name) => /attach|terminal|shell/.test(name)),
  ).toBe(false);
  for (const name of ["attach_session", "open_lead_session", "create_scratch"])
    expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});

test("Main message destinations and text are validated; removed Operator destinations are refused", async () => {
  const { client, invoke } = await connect(true);
  for (const to of [
    { kind: "run", taskId: "t", runId: "r" },
    { kind: "task", taskId: "t", role: "reviewer" },
  ]) {
    const input = {
      to,
      text: "Any context to share?",
      idempotencyKey: "same-call",
    };
    expect(
      (await client.callTool({ name: "message_agent", arguments: input }))
        .isError,
    ).not.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith(
      "message_agent",
      input,
      "repo-loom",
    );
  }
  for (const input of [
    { to: { kind: "operator" }, text: "Hello" },
    { to: { kind: "run", taskId: "t", runId: "r" }, text: "" },
    { to: { kind: "run", taskId: "t", runId: "r" }, text: "x".repeat(4001) },
    { to: { kind: "operator", taskId: "t" }, text: "Hi" },
    { to: { kind: "run", taskId: "t" }, text: "Hi" },
    { to: { kind: "task", taskId: "t", role: "main" }, text: "Hi" },
    {
      to: { kind: "run", taskId: "t", runId: "r" },
      text: "Hi",
      idempotencyKey: "",
    },
  ])
    expect(
      (await client.callTool({ name: "message_agent", arguments: input }))
        .isError,
    ).toBe(true);
});

test("Research tools are Main-only, validated and routed as coordinator commands", async () => {
  const { leadCommand } = await import("./lead.js");
  const { client, invoke } = await connect(true);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "start_research",
    "save_research",
    "list_research",
    "read_research",
  ])
    expect(names).toContain(name);
  const input = {
    id: "00000000-0000-4000-8000-000000000001",
    question: "Compare keybindings",
  };
  await client.callTool({ name: "start_research", arguments: input });
  expect(invoke).toHaveBeenCalledWith("start_research", input, "repo-loom");
  expect(leadCommand("start_research", input)).toEqual({
    kind: "start_research",
    ...input,
  });
});
