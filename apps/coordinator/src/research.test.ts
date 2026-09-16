import { randomUUID } from "node:crypto";
import type { ProviderSessionId } from "@loom/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test, vi } from "vitest";
import { createHarness, type Harness } from "./test-support.js";

const document = {
  title: "Keybindings",
  body: "Local code and web findings.",
  sources: [{ title: "Manual", url: "https://example.org/manual" }],
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const h = await createHarness();
  cleanup.push(() => h.close());
  return h;
}
async function client(h: Harness, token: string) {
  const client = new Client({ name: "research-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(h.coordinator.mcpUrl!, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}
async function start(h: Harness) {
  const entry = await h.coordinator.research.start(
    randomUUID(),
    "Compare keybindings",
    h.repoRoot,
  );
  expect(entry.status, entry.error ?? "").toBe("running");
  const recipe = h.coordinator.recipes
    .all()
    .find((r) => r.research?.id === entry.id)!;
  return { entry, recipe, session: entry.sessionId as ProviderSessionId };
}
test("interactive research uses shared launch, records identity before first turn and submits through MCP", async () => {
  const h = await setup();
  const original = h.adapters.codex;
  const adapter = await original("test" as never);
  const send = vi.spyOn(adapter, "startTurn");
  send.mockImplementation(async (request) => {
    const recipe = h.coordinator.recipes
      .all()
      .find((r) => r.sessionId === request.threadId)!;
    expect(recipe.role).toBe("research");
    expect(recipe.cwd).toBe(
      await (await import("node:fs/promises")).realpath(h.repoRoot),
    );
    expect(recipe.research?.dispatched).toBe(true);
    expect(request.sandboxPolicy).toEqual({
      type: "readOnly",
      networkAccess: false,
    });
    return { turnId: h.providers.enqueue(request.threadId, request.text) };
  });
  const { entry, recipe, session } = await start(h);
  expect(entry.pane).not.toBeNull();
  h.providers.confirm(session);
  await h.coordinator.research.refresh();
  expect(h.coordinator.research.read(entry.id).observedStatus).toBe("working");
  const agent = await client(h, recipe.token);
  expect(
    (await agent.listTools()).tools.every(
      (t) =>
        t.annotations?.destructiveHint === false &&
        t.annotations?.openWorldHint === false,
    ),
  ).toBe(true);
  expect((await agent.listTools()).tools.map((t) => t.name)).toEqual([
    "submit_research",
    "read_research_file",
    "list_research_directory",
  ]);
  expect(
    (await agent.callTool({ name: "submit_research", arguments: document }))
      .isError,
  ).toBe(false);
  h.providers.finish(session, "completed");
  await h.coordinator.research.refresh();
  expect(h.coordinator.research.read(entry.id)).toMatchObject({
    document,
    status: "completed",
    observedStatus: "idle",
  });
  for (const name of ["list_research", "get_task_context"])
    expect((await agent.callTool({ name, arguments: {} })).isError).toBe(true);
});
test("scope and concurrency refusals, failed follow-up preserves the document", async () => {
  const h = await setup();
  await expect(
    h.coordinator.research.start(randomUUID(), "q", "relative"),
  ).rejects.toThrow("absolute");
  await expect(
    h.coordinator.research.start(randomUUID(), "q", "/no-such-loom-directory"),
  ).rejects.toThrow();
  const { entry, session } = await start(h);
  await expect(
    h.coordinator.research.start(randomUUID(), "q", h.repoRoot),
  ).rejects.toThrow("already running");
  h.providers.confirm(session);
  await h.coordinator.research.submit(entry.id, document);
  h.providers.finish(session, "completed");
  await h.coordinator.research.refresh();
  await h.coordinator.research.extend(entry.id, "Compare more keys");
  h.providers.confirm(session);
  h.providers.finish(session, "failed", {
    kind: "provider failed",
    willRetry: false,
  });
  await h.coordinator.research.refresh();
  expect(h.coordinator.research.read(entry.id)).toMatchObject({
    document,
    status: "failed",
    error: "provider failed",
  });
});
test("depth enforces observed token limits without publishing partial output", async () => {
  const h = await setup();
  const { entry, recipe, session } = await start(h);
  h.providers.confirm(session);
  h.providers.get(session).tokenUsage = {
    input: recipe.research!.limits.tokens,
    output: 1,
    cachedInput: 0,
    reasoning: 0,
  };
  await h.coordinator.research.refresh();
  expect(h.coordinator.research.read(entry.id)).toMatchObject({
    status: "failed",
    document: null,
    error: "Research token budget exhausted",
  });
});
test("cached context replay does not spend the budget", async () => {
  // A live run reported 116,283 input tokens with 89,600 cached after 659 tokens of output, and
  // the old measure failed it against the 100,000 standard budget before it had done any work.
  const h = await setup();
  const { entry, recipe, session } = await start(h);
  h.providers.confirm(session);
  h.providers.get(session).tokenUsage = {
    input: recipe.research!.limits.tokens + 20_000,
    cachedInput: recipe.research!.limits.tokens + 10_000,
    output: 659,
    reasoning: 80,
  };
  await h.coordinator.research.refresh();
  expect(h.coordinator.research.read(entry.id)).toMatchObject({
    status: "running",
    error: null,
  });
});
test("restart preserves running identity and documents without replaying a prompt", async () => {
  const h = await setup();
  const savedId = randomUUID();
  h.coordinator.research.save(savedId, "Saved from Main", document);
  const { entry, recipe } = await start(h);
  const next = await h.restart();
  cleanup.splice(0);
  cleanup.push(() => next.close());
  expect(next.store.research.get(entry.id)).toMatchObject({
    status: "running",
    sessionId: entry.sessionId,
    directory: entry.directory,
  });
  expect(next.coordinator.recipes.get(recipe.runId)?.sessionId).toBe(
    entry.sessionId,
  );
  expect(next.providers.sessions.size).toBe(0);
  expect(next.store.research.get(savedId)?.document).toEqual(document);
  next.store.research.setArchived(savedId, next.clock.now());
  expect(
    next.store.research.state().entries.some((e) => e.id === savedId),
  ).toBe(false);
  expect(next.store.research.state(true).entries[0]?.origin).toBe("main");
  next.store.research.setArchived(savedId, null);
  expect(
    next.store.research.state().entries.some((e) => e.id === savedId),
  ).toBe(true);
});

test.each(["before recipe", "before Codex session", "before Claude recipe"])(
  "restart releases an incomplete launch %s without replay",
  async (boundary) => {
    const h = await setup();
    const { entry, recipe } = await start(h);
    await h.coordinator.research.stop();
    // Recreate the durable records at each pre-launch crash boundary.
    h.store.research.put({
      ...entry,
      sessionId: boundary === "before Claude recipe" ? randomUUID() : null,
      provider: boundary === "before Claude recipe" ? "claude" : "codex",
      pane: null,
      observedStatus: "unknown",
    });
    if (boundary === "before Codex session")
      await h.coordinator.recipes.save({
        ...recipe,
        sessionId: null,
        executable: null,
        args: [],
        research: { ...recipe.research!, dispatched: false, turnId: null },
      });
    else await h.coordinator.recipes.forget(recipe.runId);
    const completed = {
      ...entry,
      id: randomUUID(),
      status: "completed" as const,
      document,
      finishedAt: h.clock.now(),
      pane: null,
      observedStatus: "idle" as const,
    };
    h.store.research.put(completed);

    const next = await h.restart();
    cleanup.splice(0);
    cleanup.push(() => next.close());
    const recovered = next.coordinator.research.read(entry.id);
    expect(recovered).toMatchObject({
      status: "failed",
      document: null,
      error: expect.stringContaining("before a resumable session was recorded"),
      finishedAt: expect.any(String),
    });
    expect(next.providers.sessions.size).toBe(0);
    expect(next.coordinator.research.read(completed.id)).toEqual(completed);
    await next.coordinator.research.recover();
    expect(next.coordinator.research.read(entry.id)).toEqual(recovered);
    expect(next.providers.sessions.size).toBe(0);
    await start(next);
  },
);

test("scoped reads reject traversal and symlinks outside the named directory", async () => {
  const h = await setup();
  const { writeFile, symlink } = await import("node:fs/promises");
  await writeFile(`${h.repoRoot}/research-input.txt`, "local evidence");
  await symlink(h.dataRoot, `${h.repoRoot}/outside`);
  const { entry } = await start(h);
  expect(
    await h.coordinator.research.readScope(
      entry.id,
      "research-input.txt",
      0,
      false,
    ),
  ).toMatchObject({ text: "local evidence", eof: true });
  await expect(
    h.coordinator.research.readScope(entry.id, "..", 0, true),
  ).rejects.toThrow("outside");
  await expect(
    h.coordinator.research.readScope(entry.id, "outside", 0, true),
  ).rejects.toThrow("outside");
});

test("Claude research launches its recorded session in a pane and keeps failed follow-up output", async () => {
  const h = await setup();
  h.store.settings.update({
    scope: { kind: "global" },
    expectedVersion: 0,
    actor: "test",
    changedAt: h.clock.now(),
    changes: [],
    data: {
      research: {
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        reasoningEffort: null,
        depth: "quick",
      },
    },
  });
  const { entry, recipe, session } = await start(h);
  expect(recipe.provider).toBe("claude");
  expect(recipe.args.at(-1)).toContain("Compare keybindings");
  expect(h.providers.confirm(session)?.text).toBe(recipe.prompt);
  const agent = await client(h, recipe.token);
  expect(
    (await agent.callTool({ name: "submit_research", arguments: document }))
      .isError,
  ).toBe(false);
  h.providers.finish(session, "completed");
  await h.coordinator.research.refresh();
  await h.coordinator.research.extend(entry.id, "Add examples");
  expect(h.providers.confirm(session)?.text).toContain(document.body);
  h.providers.finish(session, "failed", {
    kind: "test failure",
    willRetry: false,
  });
  await h.coordinator.research.refresh();
  expect(h.coordinator.research.read(entry.id)).toMatchObject({
    status: "failed",
    document,
  });
});

test("recovery reconnects a surviving provider session and resumes its pane without replay", async () => {
  const h = await setup();
  const { entry, session } = await start(h);
  h.providers.confirm(session);
  await h.coordinator.research.stop();
  const { RecipeStore } = await import("./recipes.js");
  const { Research } = await import("./research.js");
  const { DEFAULT_SETTINGS } = await import("@loom/core");
  const recipes = new RecipeStore(h.store.dataDirectory);
  await recipes.load();
  const owner = new Research({
    store: h.store,
    settings: () => DEFAULT_SETTINGS.research,
    now: () => h.clock.now(),
    log: () => {},
    launch: () => ({
      adapters: h.adapters,
      recipes,
      config: h.config,
      now: () => h.clock.now(),
      dataDirectory: h.store.dataDirectory,
      mcpEntry: (token) => ({
        type: "http",
        url: h.coordinator.mcpUrl!.toString(),
        headers: { Authorization: `Bearer ${token}` },
      }),
    }),
  });
  cleanup.push(() => owner.stop());
  const adapter = await h.adapters.codex(
    recipes.all().find((r) => r.research?.id === entry.id)!.taskId,
  );
  const send = vi.spyOn(adapter, "startTurn");
  await owner.recover();
  expect(owner.read(entry.id)).toMatchObject({
    status: "running",
    observedStatus: "working",
    sessionId: session,
  });
  await owner.resume(entry.id);
  expect(send).not.toHaveBeenCalled();
  expect(h.providers.get(session).queue).toEqual([]);
});
